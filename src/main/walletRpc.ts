// src/main/walletRpc.ts
//
// Local monero-wallet-rpc endpoint: credentials, config-file contents, and the HTTP
// **Digest** client the process needs.
//
// Findings B1 (2026-11-15): the app used to start monero-wallet-rpc with
// `--disable-rpc-login` on a fixed port, so any local process (or a DNS-rebinding
// page) could drive the wallet. Now each launch gets a random loopback port and a
// random 32-byte user/pass, delivered to the RPC's own config file (mode 0600,
// removed once the server is up). monero-wallet-rpc answers `WWW-Authenticate:
// Digest` (MD5), so callers cannot use a plain Basic header — `fetch` has no
// digest support, hence the small client below.

import crypto from 'node:crypto';
import net from 'node:net';

/** 32 random bytes each, hex-encoded (the plan's random user/pass). */
export interface RpcLogin { user: string; pass: string }

/** The old fixed wallet-RPC port. B1 removed it; the guard below keeps it from ever coming back. */
export const LEGACY_WALLET_RPC_PORT = 18082;

export function randomLogin(): RpcLogin {
  return {
    user: crypto.randomBytes(32).toString('hex'),
    pass: crypto.randomBytes(32).toString('hex'),
  };
}

/** The only thing written to disk, briefly: monero-wallet-rpc's own option syntax. */
export function configFileContents(login: RpcLogin): string {
  return `rpc-login=${login.user}:${login.pass}\nrpc-bind-ip=127.0.0.1\n`;
}

/** Config files this module owns; a launch sweep removes any left by a crash. */
export function isOwnedConfigName(name: string): boolean {
  return /^wallet-rpc-[a-z0-9-]+\.conf$/.test(name);
}

export function configFileName(): string {
  return `wallet-rpc-${process.pid}-${crypto.randomBytes(6).toString('hex')}.conf`;
}

/** An ephemeral loopback port the OS just confirmed is free (closed before use; the RPC binds it
 *  microseconds later — a random fixed range would collide far more often than this race). */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('could not allocate a loopback port'))));
    });
  });
}

export interface DigestChallenge {
  realm: string;
  nonce: string;
  opaque?: string;
  algorithm?: string;
  qop?: string;
}

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

/** Split `key=value, key="quoted, value"` without being fooled by commas inside quotes. */
function splitParams(s: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/** Parse the FIRST Digest challenge in a WWW-Authenticate value (other schemes ignored). */
export function parseDigestChallenge(header: string | null | undefined): DigestChallenge | null {
  if (!header) return null;
  const at = header.indexOf('Digest ');
  if (at < 0) return null;
  let rest = header.slice(at + 'Digest '.length);
  const nextScheme = rest.search(/,\s*(Basic|Bearer|Negotiate|Digest)\s/i);
  if (nextScheme >= 0) rest = rest.slice(0, nextScheme);
  const params: Record<string, string> = {};
  for (const part of splitParams(rest)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (key && !(key in params)) params[key] = value;
  }
  if (!params.realm || !params.nonce) return null;
  return {
    realm: params.realm,
    nonce: params.nonce,
    opaque: params.opaque,
    algorithm: params.algorithm,
    qop: params.qop,
  };
}

/** The Authorization header value for one request (RFC 2617 MD5 / MD5-sess, qop=auth). */
export function digestAuthorization(opts: {
  login: RpcLogin;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  nc: number;
  cnonce: string;
}): string {
  const { login, method, uri, challenge, nc, cnonce } = opts;
  const algorithm = (challenge.algorithm || 'MD5').toUpperCase();
  let ha1 = md5(`${login.user}:${challenge.realm}:${login.pass}`);
  if (algorithm === 'MD5-SESS') ha1 = md5(`${ha1}:${challenge.nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const ncHex = nc.toString(16).padStart(8, '0');
  const qop = challenge.qop?.split(',').map((q) => q.trim()).find((q) => q === 'auth');
  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);
  const parts = [
    `username="${login.user}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
    challenge.opaque ? `opaque="${challenge.opaque}"` : '',
    challenge.algorithm ? `algorithm=${challenge.algorithm}` : '',
  ].filter(Boolean);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cnonce}"`);
  return `Digest ${parts.join(', ')}`;
}

// ── the client ────────────────────────────────────────────────────────────────────────────────

export interface WalletRpcEndpoint { url: string; login: RpcLogin }

export class WalletRpcError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = 'WalletRpcError'; }
}

/**
 * POST a JSON-RPC body to the wallet RPC, authenticating with Digest.
 *
 * The first call learns the challenge from a 401; later calls reuse it (with an
 * incrementing nonce count) and transparently re-authenticate when the server
 * marks the nonce stale. Two consecutive 401s for the same request are fatal:
 * that is a credential mismatch, not a challenge refresh.
 */
export class WalletRpcClient {
  private challenge: DigestChallenge | null = null;
  private nc = 0;
  /** A restart binds a new port with a new nonce space; never reuse a challenge across endpoints. */
  private lastUrl: string | null = null;

  constructor(
    private readonly endpoint: () => WalletRpcEndpoint | null,
    private readonly fetchImpl: typeof fetch,
  ) {}

  /** Requests are serialized: the challenge and nonce counter are shared state, and monero-wallet-rpc is
   *  single-threaded — overlapping posts could race the first-challenge handshake or the nonce count. */
  private tail: Promise<unknown> = Promise.resolve();

  post(body: unknown): Promise<Response> {
    const next = this.tail.then(() => this.postOnce(body));
    this.tail = next.catch(() => { /* a failed request must not poison the queue */ });
    return next;
  }

  private async postOnce(body: unknown): Promise<Response> {
    const ep = this.endpoint();
    if (!ep) throw new WalletRpcError('wallet RPC is not running');
    if (ep.url !== this.lastUrl) { this.lastUrl = ep.url; this.challenge = null; this.nc = 0; }
    const payload = JSON.stringify(body);
    const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload };

    if (!this.challenge) {
      const probe = await this.fetchImpl(ep.url, init);
      if (probe.status !== 401) {
        // The server accepted an UNAUTHENTICATED wallet call: it is not the authenticated RPC we
        // started (or it ignored rpc-login). Never drive a wallet through an open endpoint.
        throw new WalletRpcError('wallet RPC is not requiring authentication — refusing to use it', probe.status);
      }
      const challenge = parseDigestChallenge(probe.headers.get('www-authenticate'));
      if (!challenge) throw new WalletRpcError('wallet RPC demanded authentication without a Digest challenge', 401);
      this.challenge = challenge;
      this.nc = 0;
    }

    this.nc += 1;
    const headers = {
      ...(init.headers as Record<string, string>),
      Authorization: digestAuthorization({
        login: ep.login, method: 'POST', uri: uriOf(ep.url), challenge: this.challenge, nc: this.nc,
        cnonce: crypto.randomBytes(8).toString('hex'),
      }),
    };
    const authed = await this.fetchImpl(ep.url, { ...init, headers });

    if (authed.status !== 401) return authed;
    // Stale nonce → refresh once; a second 401 is a real credential failure.
    const fresh = parseDigestChallenge(authed.headers.get('www-authenticate'));
    if (!fresh || fresh.nonce === this.challenge.nonce) {
      throw new WalletRpcError('wallet RPC rejected the credentials', 401);
    }
    this.challenge = fresh;
    this.nc = 1;
    const retry = await this.fetchImpl(ep.url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string>),
        Authorization: digestAuthorization({
          login: ep.login, method: 'POST', uri: uriOf(ep.url), challenge: fresh, nc: 1,
          cnonce: crypto.randomBytes(8).toString('hex'),
        }),
      },
    });
    if (retry.status === 401) throw new WalletRpcError('wallet RPC rejected the credentials', 401);
    return retry;
  }
}

function uriOf(url: string): string {
  try { return new URL(url).pathname || '/'; } catch { return '/'; }
}


/**
 * Startup gate: prove the freshly launched RPC both DEMANDS Digest auth and accepts the credentials we
 * generated. An endpoint that answers unauthenticated calls is refused outright (B1 review).
 */
export async function assertRpcRequiresAuth(
  url: string,
  login: RpcLogin,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_version' });
  const init: RequestInit = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body };
  const probe = await fetchImpl(url, init);
  if (probe.status !== 401) {
    throw new WalletRpcError(`wallet RPC answered ${probe.status} without demanding authentication — refusing to use it`, probe.status);
  }
  const challenge = parseDigestChallenge(probe.headers.get('www-authenticate'));
  if (!challenge) throw new WalletRpcError('wallet RPC did not present a Digest challenge', 401);
  const cnonce = crypto.randomBytes(8).toString('hex');
  const authed = await fetchImpl(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string>),
      Authorization: digestAuthorization({ login, method: 'POST', uri: uriOf(url), challenge, nc: 1, cnonce }),
    },
  });
  if (authed.status === 401) throw new WalletRpcError('wallet RPC rejected the generated credentials', 401);
  if (!authed.ok) throw new WalletRpcError(`wallet RPC health check failed (${authed.status})`, authed.status);
}
