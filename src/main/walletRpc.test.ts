import { describe, it, expect } from 'vitest';
import net from 'node:net';
import {
  randomLogin, configFileContents, isOwnedConfigName, configFileName, freeLoopbackPort,
  parseDigestChallenge, digestAuthorization, WalletRpcClient, WalletRpcError, assertRpcRequiresAuth,
} from './walletRpc';

/**
 * B1 (2026-11-15): the local monero-wallet-rpc is authenticated per launch. These tests pin the
 * credential/config shape, the Digest client (monero answers Digest, not Basic — `fetch` cannot do
 * it by itself) and the endpoint-change behaviour, without any Electron runtime.
 */

describe('credentials and config file', () => {
  it('generates 32-byte hex user/pass pairs, different per call', () => {
    const a = randomLogin();
    const b = randomLogin();
    expect(a.user).toMatch(/^[0-9a-f]{64}$/);
    expect(a.pass).toMatch(/^[0-9a-f]{64}$/);
    expect(a.user).not.toBe(b.user);
    expect(a.pass).not.toBe(b.pass);
  });
  it('writes the pair in monero config syntax, loopback only', () => {
    const text = configFileContents({ user: 'u1', pass: 'p1' });
    expect(text).toBe('rpc-login=u1:p1\nrpc-bind-ip=127.0.0.1\n');
  });
  it('owns only its own config filenames (crash sweep predicate)', () => {
    expect(isOwnedConfigName(configFileName())).toBe(true);
    expect(isOwnedConfigName('wallet-rpc-123-ab12cd.conf')).toBe(true);
    expect(isOwnedConfigName('monero-wallet-rpc.log')).toBe(false);
    expect(isOwnedConfigName('wallet.conf')).toBe(false);
    expect(isOwnedConfigName('../wallet-rpc-1-conf')).toBe(false);
  });
  it('allocates a port the OS confirms free', async () => {
    const port = await freeLoopbackPort();
    expect(port).toBeGreaterThan(1023);
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
    });
  });
});

describe('Digest (RFC 2617)', () => {
  it('parses the first challenge out of a joined header', () => {
    const c = parseDigestChallenge(
      'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="abc==", Basic realm="x"',
    );
    expect(c).toMatchObject({ realm: 'monero-rpc', nonce: 'abc==', algorithm: 'MD5', qop: 'auth' });
    expect(parseDigestChallenge('Basic realm="x"')).toBeNull();
    expect(parseDigestChallenge(null)).toBeNull();
  });

  it('computes the RFC 2617 §3.5 example', () => {
    const header = digestAuthorization({
      login: { user: 'Mufasa', pass: 'Circle Of Life' },
      method: 'GET',
      uri: '/dir/index.html',
      challenge: { realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093', qop: 'auth' },
      nc: 1,
      cnonce: '0a4f113b',
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
    expect(header).toContain('qop=auth');
    expect(header).toContain('nc=00000001');
  });
});

describe('WalletRpcClient', () => {
  const login = { user: 'u', pass: 'p' };
  const url = 'http://127.0.0.1:33333/json_rpc';
  const challenge = 'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="n1"';

  function fakeFetch(script: Array<{ status: number; challenge?: string }>) {
    const calls: Array<{ auth?: string }> = [];
    const impl = (async (_url: any, init?: any) => {
      calls.push({ auth: (init?.headers as any)?.Authorization });
      const step = script.shift() ?? { status: 200 };
      return new Response(step.status === 200 ? '{"result":1}' : '', {
        status: step.status,
        headers: step.challenge ? { 'WWW-Authenticate': step.challenge } : {},
      });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it('learns the challenge from the first 401, then reuses the nonce', async () => {
    const { impl, calls } = fakeFetch([{ status: 401, challenge }, { status: 200 }, { status: 200 }]);
    const client = new WalletRpcClient(() => ({ url, login }), impl);
    expect((await client.post({ method: 'a' })).status).toBe(200);
    expect((await client.post({ method: 'b' })).status).toBe(200);
    expect(calls).toHaveLength(3);           // 401 + authed + cached authed (no second probe)
    expect(calls[0].auth).toBeUndefined();
    expect(calls[1].auth).toMatch(/^Digest /);
    expect(calls[2].auth).toMatch(/^Digest /);
    expect(calls[2].auth).toMatch(/nc=00000002/);
  });

  it('refreshes a stale nonce once, and treats a repeated 401 as bad credentials', async () => {
    const { impl } = fakeFetch([
      { status: 401, challenge }, { status: 401, challenge: 'Digest realm="monero-rpc",nonce="n2"' }, { status: 200 },
    ]);
    const client = new WalletRpcClient(() => ({ url, login }), impl);
    expect((await client.post({})).status).toBe(200);

    const rejected = fakeFetch([{ status: 401, challenge }, { status: 401, challenge }]);
    const bad = new WalletRpcClient(() => ({ url: url + '?x', login }), rejected.impl);
    await expect(bad.post({})).rejects.toBeInstanceOf(WalletRpcError);
  });

  it('forgets the challenge when the endpoint changes (new port per launch)', async () => {
    const { impl, calls } = fakeFetch([{ status: 401, challenge }, { status: 200 }, { status: 401, challenge }, { status: 200 }]);
    let port = 33333;
    const client = new WalletRpcClient(() => ({ url: `http://127.0.0.1:${port}/json_rpc`, login }), impl);
    await client.post({});
    port = 44444;
    await client.post({});
    expect(calls).toHaveLength(4);           // a fresh 401 probe for the new endpoint
  });

  it('fails closed when the endpoint does not demand authentication', async () => {
    // A 200 to an UNAUTHENTICATED call means the server ignored rpc-login: never drive it.
    const { impl } = fakeFetch([{ status: 200 }]);
    const client = new WalletRpcClient(() => ({ url, login }), impl);
    await expect(client.post({})).rejects.toBeInstanceOf(WalletRpcError);
  });

  it('fails loudly when the RPC is not running', async () => {
    const client = new WalletRpcClient(() => null, (async () => new Response('', { status: 200 })) as unknown as typeof fetch);
    await expect(client.post({})).rejects.toBeInstanceOf(WalletRpcError);
  });
});


describe('startup auth gate', () => {
  const login = { user: 'u', pass: 'p' };
  const url = 'http://127.0.0.1:33333/json_rpc';
  const challenge = 'Digest qop="auth",algorithm=MD5,realm="monero-rpc",nonce="n1"';

  const scripted = (steps: Array<{ status: number; headers?: Record<string, string> }>) => {
    const calls: Array<{ auth?: string }> = [];
    const impl = (async (_u: any, init?: any) => {
      calls.push({ auth: (init?.headers as any)?.Authorization });
      const step = steps.shift() ?? { status: 200 };
      return new Response('{}', { status: step.status, headers: step.headers ?? {} });
    }) as unknown as typeof fetch;
    return { impl, calls };
  };

  it('accepts a server that demands Digest and honours our credentials', async () => {
    const { impl, calls } = scripted([
      { status: 401, headers: { 'WWW-Authenticate': challenge } },
      { status: 200 },
    ]);
    await expect(assertRpcRequiresAuth(url, login, impl)).resolves.toBeUndefined();
    expect(calls[1].auth).toMatch(/^Digest /);
  });

  it('refuses an unauthenticated server, a non-Digest 401, or rejected credentials', async () => {
    const open = scripted([{ status: 200 }]);
    await expect(assertRpcRequiresAuth(url, login, open.impl)).rejects.toBeInstanceOf(WalletRpcError);

    const basic = scripted([{ status: 401, headers: { 'WWW-Authenticate': 'Basic realm="x"' } }]);
    await expect(assertRpcRequiresAuth(url, login, basic.impl)).rejects.toBeInstanceOf(WalletRpcError);

    const rejected = scripted([
      { status: 401, headers: { 'WWW-Authenticate': challenge } },
      { status: 401, headers: { 'WWW-Authenticate': challenge } },
    ]);
    await expect(assertRpcRequiresAuth(url, login, rejected.impl)).rejects.toBeInstanceOf(WalletRpcError);
  });
});
