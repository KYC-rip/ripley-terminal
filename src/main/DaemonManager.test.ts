import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * B1 lifecycle (2026-11-15): the wallet RPC must start authenticated, remove its credential file even
 * when startup fails, recover from a post-ready crash, and never launch twice for concurrent callers.
 * Electron and child_process are mocked; the manager's own logic runs for real.
 */
const h = vi.hoisted(() => ({
  userData: '',
  procs: [] as any[],
  spawnCount: 0,
  netFetch: null as any,
  portProvider: (() => Promise.resolve(28123)) as () => Promise<number>,
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => h.userData },
  net: { fetch: (...args: any[]) => h.netFetch(...args) },
}));

vi.mock('./walletRpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./walletRpc')>();
  return { ...actual, freeLoopbackPort: () => h.portProvider() };   // port allocation is controllable
});

vi.mock('child_process', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    spawn: () => {
      h.spawnCount += 1;
      const proc: any = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => { proc.killed = true; };
      h.procs.push(proc);
      return proc;
    },
  };
});

import { DaemonManager } from './DaemonManager';

const configs = () => fs.readdirSync(h.userData).filter((f) => f.startsWith('wallet-rpc-'));

beforeEach(() => {
  h.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'term-rpc-'));
  h.procs.length = 0;
  h.spawnCount = 0;
  h.portProvider = () => Promise.resolve(28123);
  // A correct server: unauthenticated → 401 + Digest, authenticated → 200.
  h.netFetch = vi.fn(async (_url: string, init?: any) => {
    const authed = Boolean(init?.headers?.Authorization);
    return new Response('{}', {
      status: authed ? 200 : 401,
      headers: authed ? {} : { 'WWW-Authenticate': 'Digest realm="monero-rpc",nonce="n1"' },
    });
  });
});

async function startAndReady(dm: DaemonManager): Promise<void> {
  const p = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
  await new Promise((r) => setTimeout(r, 20));           // let the port allocation + spawn happen
  h.procs[h.procs.length - 1].stdout.emit('data', Buffer.from('Binding on 127.0.0.1:12345'));
  await p;
}

describe('DaemonManager wallet-RPC lifecycle', () => {
  it('sweeps credential files left by a previous crash', () => {
    fs.writeFileSync(path.join(h.userData, 'wallet-rpc-1-abc.conf'), 'rpc-login=a:b\n', { mode: 0o600 });
    fs.writeFileSync(path.join(h.userData, 'wallet.conf'), 'keep me');
    new DaemonManager();
    expect(configs()).toEqual([]);
    expect(fs.readdirSync(h.userData)).toContain('wallet.conf');
  });

  it('removes the credential file when startup fails, and exposes no endpoint', async () => {
    const dm = new DaemonManager();
    const p = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 20));
    expect(configs()).toHaveLength(1);                 // written while launching
    h.procs[h.procs.length - 1].emit('error', new Error('spawn failed'));
    await expect(p).rejects.toThrow(/spawn failed/);
    expect(configs()).toEqual([]);
    expect(dm.getWalletRpc()).toBeNull();
  });

  it('fails startup when the RPC does not demand authentication (no silent open wallet)', async () => {
    h.netFetch = vi.fn(async () => new Response('{}', { status: 200 }));
    const dm = new DaemonManager();
    const p = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 20));
    h.procs[h.procs.length - 1].stdout.emit('data', Buffer.from('Binding on 127.0.0.1:12345'));
    await expect(p).rejects.toThrow(/without demanding authentication/);
    expect(dm.getWalletRpc()).toBeNull();
    expect(configs()).toEqual([]);
  });

  it('a fresh start after killAll does not inherit a canceled launch still waiting for a port', async () => {
    let releaseOld!: () => void;
    let calls = 0;
    h.portProvider = () => {
      calls += 1;
      return calls === 1 ? new Promise<number>((res) => { releaseOld = () => res(28124); }) : Promise.resolve(28125);
    };
    const dm = new DaemonManager();
    const old = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 5));
    const stopped = expect(old).rejects.toThrow(/stopped/);
    dm.killAll();                                   // cancel while the old port is still pending

    // Restart IMMEDIATELY, before the old allocation settles.
    await startAndReady(dm);
    expect(h.spawnCount).toBe(1);
    const live = dm.getWalletRpc();
    expect(live).not.toBeNull();

    releaseOld!();                                  // the canceled launch's port finally arrives
    await stopped;
    await new Promise((r) => setTimeout(r, 5));
    expect(h.spawnCount).toBe(1);                   // it spawned nothing and kept its hands off
    expect(dm.getWalletRpc()).toBe(live);
  });

  it('clears a dead endpoint after a post-ready crash and relaunches on the next start', async () => {
    const dm = new DaemonManager();
    await startAndReady(dm);
    expect(dm.getWalletRpc()).not.toBeNull();
    expect(configs()).toEqual([]);                     // deleted once the server is up

    h.procs[0].emit('close', 1);                       // crash after ready
    expect(dm.getWalletRpc()).toBeNull();

    await startAndReady(dm);                           // must spawn a NEW process
    expect(h.spawnCount).toBe(2);
    expect(dm.getWalletRpc()).not.toBeNull();
    expect(dm.getWalletRpc()!.url).not.toBe('http://127.0.0.1:12345/json_rpc');
  });

  it('starts exactly one auth probe for repeated readiness lines', async () => {
    const dm = new DaemonManager();
    const p = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 20));
    const proc = h.procs[0];
    proc.stdout.emit('data', Buffer.from('Binding on 127.0.0.1:12345'));
    proc.stdout.emit('data', Buffer.from('Starting wallet RPC server'));
    proc.stdout.emit('data', Buffer.from('Binding on 127.0.0.1:12345'));
    await p;
    expect(dm.getWalletRpc()).not.toBeNull();
    expect(h.netFetch).toHaveBeenCalledTimes(2);   // one unauthenticated probe + one authenticated
  });

  it('shutdown during a delayed probe publishes nothing and rejects the caller', async () => {
    let releaseProbe: (() => void) | null = null;
    h.netFetch = vi.fn((_url: string, init?: any) => new Promise<Response>((resolve) => {
      releaseProbe = () => resolve(new Response('{}', {
        status: init?.headers?.Authorization ? 200 : 401,
        headers: init?.headers?.Authorization ? {} : { 'WWW-Authenticate': 'Digest realm="monero-rpc",nonce="n1"' },
      }));
    }));
    const dm = new DaemonManager();
    const p = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 20));
    h.procs[0].stdout.emit('data', Buffer.from('Binding on 127.0.0.1:12345'));
    await new Promise((r) => setTimeout(r, 5));
    const stopped = expect(p).rejects.toThrow(/stopped/);   // attach before the synchronous reject
    dm.killAll();                                   // shutdown while the probe is in flight
    releaseProbe!();                                 // the probe answers after shutdown
    await new Promise((r) => setTimeout(r, 5));
    expect(dm.getWalletRpc()).toBeNull();
    await stopped;
  });

  it('ignores a stale process closing after a newer launch', async () => {
    const dm = new DaemonManager();
    await startAndReady(dm);
    const first = h.procs[0];
    first.emit('close', 1);                          // crash → endpoint cleared
    await startAndReady(dm);                         // second launch
    expect(dm.getWalletRpc()).not.toBeNull();
    first.emit('close', 1);                          // stale close of the old process
    expect(dm.getWalletRpc()).not.toBeNull();
  });

  it('cancels a launch during delayed port allocation, then starts cleanly', async () => {
    let release!: () => void;
    h.portProvider = () => new Promise<number>((res) => { release = () => res(28124); });
    const dm = new DaemonManager();
    const p = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 5));
    const stopped = expect(p).rejects.toThrow(/stopped/);   // attach before the synchronous reject
    dm.killAll();                                            // shutdown while the port is pending
    release!();                                              // port allocation finishes after shutdown
    await stopped;
    expect(h.spawnCount).toBe(0);                            // no process was ever spawned
    expect(configs()).toEqual([]);                           // no credentials were written
    expect(dm.getWalletRpc()).toBeNull();

    h.portProvider = () => Promise.resolve(28125);
    await startAndReady(dm);                                 // a fresh launch must not inherit the cancel
    expect(h.spawnCount).toBe(1);
    expect(dm.getWalletRpc()).not.toBeNull();
  });

  it('shares one launch between concurrent callers', async () => {
    const dm = new DaemonManager();
    const a = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    const b = dm.startMoneroRpc('node.example:18081', false, false, '', 'mainnet');
    await new Promise((r) => setTimeout(r, 20));
    expect(h.spawnCount).toBe(1);
    h.procs[0].stdout.emit('data', Buffer.from('Binding on 127.0.0.1:12345'));
    await Promise.all([a, b]);
    expect(dm.getWalletRpc()).not.toBeNull();
  });
});
