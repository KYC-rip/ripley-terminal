// src/main/DaemonManager.ts
import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { app, net } from 'electron';
import {
  randomLogin, configFileContents, configFileName, isOwnedConfigName, freeLoopbackPort,
  assertRpcRequiresAuth, type RpcLogin, type WalletRpcEndpoint,
} from './walletRpc';

export class DaemonManager {
  private binPath: string;
  private torPath: string;
  private rpcPath: string;
  private walletDir: string;

  private torProcess: ChildProcess | null = null;
  private rpcProcess: ChildProcess | null = null;

  public readonly torSocksPort = 9052;

  // B1 (2026-11-15): the wallet RPC is authenticated + on a per-launch random port. The credentials and
  // endpoint stay in the MAIN process (every caller lives here); nothing is exposed to the renderer.
  private rpcEndpoint: WalletRpcEndpoint | null = null;
  private rpcConfigPath: string | null = null;

  /** The live endpoint, or null while the RPC is not up. */
  public getWalletRpc(): WalletRpcEndpoint | null {
    return this.rpcEndpoint;
  }

  private onLog?: (source: string, level: 'info' | 'error', message: string) => void;

  public setLogListener(listener: (source: string, level: 'info' | 'error', message: string) => void) {
    this.onLog = listener;
  }

  private emitLog(source: string, level: 'info' | 'error', message: string) {
    if (this.onLog) this.onLog(source, level, message);
  }

  constructor() {
    this.binPath = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, '../../resources/bin');

    const ext = process.platform === 'win32' ? '.exe' : '';
    this.torPath = path.join(this.binPath, `tor-bundle/tor/tor${ext}`);
    this.rpcPath = path.join(this.binPath, `rpc-core/monero-wallet-rpc${ext}`);

    this.walletDir = path.join(app.getPath('userData'), 'wallets');
    if (!fs.existsSync(this.walletDir)) fs.mkdirSync(this.walletDir, { recursive: true });

    // A crash between writing the config file and its removal leaves credentials on disk; any file
    // this module owns from a previous run is deleted before a new launch.
    this.sweepStaleConfigs();
  }

  private sweepStaleConfigs(): void {
    try {
      for (const name of fs.readdirSync(app.getPath('userData'))) {
        if (isOwnedConfigName(name)) {
          try { fs.rmSync(path.join(app.getPath('userData'), name), { force: true }); } catch { /* best effort */ }
        }
      }
    } catch { /* userData not readable yet — nothing to sweep */ }
  }

  /** Write the 0600 config file; returns its path. */
  private writeRpcConfig(login: RpcLogin): string {
    const file = path.join(app.getPath('userData'), configFileName());
    fs.writeFileSync(file, configFileContents(login), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* umask already applied 0600 */ }
    this.rpcConfigPath = file;
    return file;
  }

  private removeRpcConfig(): void {
    if (this.rpcConfigPath) {
      try { fs.rmSync(this.rpcConfigPath, { force: true }); } catch { /* best effort */ }
      this.rpcConfigPath = null;
    }
  }

  public async startTor(systemProxy?: string): Promise<void> {
    if (process.platform !== 'win32') {
      const { execSync } = require('child_process');
      try {
        execSync("lsof -ti:9053 | xargs kill -9 > /dev/null 2>&1");
        console.log('[TOR] Cleaned up zombie processes from previous sessions.');
      } catch (e) {
      }

      try {
        fs.chmodSync(this.torPath, 0o755);
        const lyrebirdPath = path.join(this.binPath, 'tor-bundle', 'pluggable_transports', 'lyrebird');
        if (fs.existsSync(lyrebirdPath)) fs.chmodSync(lyrebirdPath, 0o755);
      } catch (chmodErr) {
        console.warn('[TOR] Warning: Failed to grant execution permissions. EACCES might occur:', chmodErr);
      }
    }

    return new Promise((resolve, reject) => {
      if (this.torProcess) return resolve();

      console.log('[TOR] Igniting darknet engine...');
      const torArgs = [
        '--SocksPort', `${this.torSocksPort}`,
        '--ControlPort', '9053',
        '--CookieAuthentication', '1',
        '--DataDirectory', path.join(app.getPath('userData'), 'tor_data'),
        '--Log', 'notice stdout' // 📢 FORCE Tor to stream its inner thoughts to standard output
      ];

      if (systemProxy) {
        let proxyType = '--Socks5Proxy';
        let cleanProxy = systemProxy;

        if (systemProxy.startsWith('socks5://')) {
          cleanProxy = systemProxy.replace('socks5://', '');
        } else if (systemProxy.startsWith('http://')) {
          proxyType = '--HTTPSProxy';
          cleanProxy = systemProxy.replace('http://', '');
        } else if (systemProxy.startsWith('https://')) {
          proxyType = '--HTTPSProxy';
          cleanProxy = systemProxy.replace('https://', '');
        }

        console.log(`[TOR] Mounting system proxy: ${proxyType} ${cleanProxy}`);
        torArgs.push(proxyType, cleanProxy);
      }

      const env = Object.assign({}, process.env);
      if (process.platform === 'darwin') {
        env.DYLD_LIBRARY_PATH = path.dirname(this.torPath);
        env.DYLD_FALLBACK_LIBRARY_PATH = path.dirname(this.torPath);
      }

      this.torProcess = spawn(this.torPath, torArgs, {
        env,
        stdio: 'pipe'
      });

      this.torProcess.stdout?.on('data', (data: Buffer) => {
        const rawLogs = data.toString().split('\n'); // 🛡️ Split into single lines
        rawLogs.forEach(line => {
          const log = line.trim();
          if (!log) return;
          this.emitLog('TOR', 'info', log);
        });
        console.log(`[TOR-CORE] ${rawLogs.join('\n')}`);

        if (rawLogs.some(line => line.includes('Bootstrapped 100%'))) {
          console.log('[TOR] Tunnel established successfully. (100%)');
          resolve();
        }
      });

      this.torProcess.stderr?.on('data', (data: Buffer) => {
        const errLog = data.toString().trim();
        if (errLog) {
          console.error(`[TOR-ERR] ${errLog}`);
          this.emitLog('TOR', 'error', errLog);
        }
      });

      // 🛑 FIXED: Now catches Signal terminations (code === null)
      this.torProcess.on('close', (code, signal) => {
        if (code !== 0) {
          const exitReason = code !== null ? `Code: ${code}` : `Signal: ${signal}`;
          const msg = `Process exited unexpectedly (${exitReason}).`;
          console.error(`[TOR-FATAL] ${msg}`);
          this.emitLog('TOR', 'error', msg);
          this.torProcess = null;
          reject(new Error(msg));
        }
      });

      this.torProcess.on('error', (err) => {
        console.error(`[TOR-ERROR] ${err.message}`);
        this.emitLog('TOR', 'error', err.message);
        reject(err);
      });
    });
  }

  private rpcStarting: Promise<void> | null = null;
  /** The launch that has not yet published an endpoint; killAll() cancels it at ANY stage. */
  private pendingLaunch: { cancelled: boolean } | null = null;
  /** Rejects the in-flight start when killAll() stops it (otherwise its caller waits forever). */
  private pendingReject: ((err: Error) => void) | null = null;

  public startMoneroRpc(
    targetNode: string,
    useTor: boolean,
    useSystemProxy: boolean,
    systemProxyAddress: string,
    network: string
  ): Promise<void> {
    if (this.rpcEndpoint && this.rpcProcess) return Promise.resolve();
    if (this.rpcStarting) return this.rpcStarting;   // concurrent callers share one launch
    const run: Promise<void> = this.spawnMoneroRpc(targetNode, useTor, useSystemProxy, systemProxyAddress, network)
      .finally(() => { if (this.rpcStarting === run) this.rpcStarting = null; });
    this.rpcStarting = run;
    return run;
  }

  private async spawnMoneroRpc(
    targetNode: string,
    useTor: boolean,
    useSystemProxy: boolean,
    systemProxyAddress: string,
    network: string
  ): Promise<void> {
    // Cancellation state exists BEFORE any await: killAll() can arrive while the port is being
    // allocated and must still stop the launch (review round 4).
    const launch = { cancelled: false };
    this.pendingLaunch = launch;
    const aborted = () => launch.cancelled;
    let rejectCancelled!: (err: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancelled = reject; });
    // killAll() may reject this before the race below is even built (port allocation still pending);
    // keep that from surfacing as an unhandled rejection without swallowing it for the race.
    void cancelled.catch(() => {});
    this.pendingReject = rejectCancelled;

    try {
      if (process.platform !== 'win32') {
        try {
          fs.chmodSync(this.rpcPath, 0o755);
        } catch (chmodErr) {
          console.warn('[RPC] Warning: Failed to grant execution permissions:', chmodErr);
        }
      }

      // Race the allocation against cancellation so killAll() settles this launch promptly (its
      // caller and the in-flight slot must not stay busy until the OS answers).
      const port = await Promise.race([freeLoopbackPort(), cancelled]);
      if (aborted()) throw new Error('wallet RPC stopped');

      const login = randomLogin();
      const configFile = this.writeRpcConfig(login);
      if (aborted()) throw new Error('wallet RPC stopped');

      console.log(`[RPC] Mounting stealth core. Target: ${targetNode} | Tor: ${useTor}`);
      const rpcArgs = [
        '--wallet-dir', this.walletDir,
        '--rpc-bind-port', `${port}`,
        '--rpc-bind-ip', '127.0.0.1',
        // Credentials come from the 0600 config file (deleted on ready), NOT from the command line,
        // which every local user can read via `ps`.
        '--config-file', configFile,
        '--daemon-address', targetNode,
        '--max-concurrency', '4',
        '--no-initial-sync'
      ];

      if (network === 'stagenet') {
        rpcArgs.push('--stagenet');
      } else if (network === 'testnet') {
        rpcArgs.push('--testnet');
      }

      const env = Object.assign({}, process.env);
      if (useTor) {
        const proxyAddr = `127.0.0.1:${this.torSocksPort}`;
        rpcArgs.push('--proxy', proxyAddr);
        rpcArgs.push('--daemon-ssl-allow-any-cert');
        console.log(`[RPC] Applying Tor Proxy for Remote Node: ${proxyAddr} -> ${targetNode}`);
      } else if (useSystemProxy) {
        // Because dual-protocol proxies (e.g. Clash Mix port 1082) fail with monero's native SOCKS4a --proxy argument,
        // we inject standard proxy environment variables instead so curl/epee can route via HTTP Connect.
        env.HTTP_PROXY = systemProxyAddress;
        env.HTTPS_PROXY = systemProxyAddress;
        env.ALL_PROXY = systemProxyAddress;
        rpcArgs.push('--daemon-ssl-allow-any-cert');
        console.log(`[RPC] Applying Custom HTTP/SOCKS Proxy (EnvVar): ${systemProxyAddress} -> ${targetNode}`);
      } else {
        console.log(`[RPC] Direct Clearnet Connection -> ${targetNode}`);
      }

      if (aborted()) throw new Error('wallet RPC stopped');
      await Promise.race([this.launchChild(launch, port, login, rpcArgs, env), cancelled]);
    } catch (err) {
      this.rpcEndpoint = null;
      this.removeRpcConfig();
      if (this.rpcProcess) {
        try { this.rpcProcess.kill(); } catch { /* already gone */ }
        this.rpcProcess = null;
      }
      throw err instanceof Error ? err : new Error(String(err));
    } finally {
      if (this.pendingLaunch === launch) this.pendingLaunch = null;
      if (this.pendingReject === rejectCancelled) this.pendingReject = null;
    }
  }

  /** Spawn the authenticated RPC and resolve only when the auth gate has passed. */
  private launchChild(
    launch: { cancelled: boolean },
    port: number,
    login: RpcLogin,
    rpcArgs: string[],
    env: NodeJS.ProcessEnv,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const aborted = () => launch.cancelled;
      let settled = false;
      let probeStarted = false;   // duplicate readiness lines must not start a second probe
      const clearLive = () => { this.rpcEndpoint = null; this.removeRpcConfig(); };
      const fail = (err: Error) => {
        // Shutdown or a newer launch already owns the state: settle without touching anything.
        if (aborted() || this.rpcProcess !== proc) { resolve(); return; }
        clearLive();
        try { proc.kill(); } catch { /* already gone */ }
        this.rpcProcess = null;
        if (settled) { console.error('[RPC-FATAL]', err.message); return; }
        settled = true;
        console.error(`[RPC-FATAL] ${err.message}`);
        this.emitLog('RPC', 'error', err.message);
        reject(err);
      };

      const proc = spawn(this.rpcPath, rpcArgs, { env, stdio: 'pipe' });
      this.rpcProcess = proc;

      const readyPattern = (text: string) => /Starting wallet RPC server/i.test(text) || /Binding on 127\.0\.0\.1/i.test(text);

      proc.stdout?.on('data', (data: Buffer) => {
        const log = data.toString().trim();
        if (!log) return;
        console.log(`[RPC-CORE] ${log}`);
        this.emitLog('RPC', 'info', log);
        if (!settled && !probeStarted && !aborted() && this.rpcProcess === proc && readyPattern(log)) {
          probeStarted = true;
          // The RPC parsed its config; the credentials no longer need to exist on disk. Prove the
          // server both demands auth and accepts them before anyone is allowed to call the wallet.
          this.removeRpcConfig();
          const url = `http://127.0.0.1:${port}/json_rpc`;
          assertRpcRequiresAuth(url, login, ((input: any, init?: any) => net.fetch(input, init)) as typeof fetch)
            .then(() => {
              // killAll() or a newer launch may have happened while the probe was in flight.
              if (settled || aborted() || this.rpcProcess !== proc) { resolve(); return; }
              settled = true;
              this.rpcEndpoint = { url, login };
              console.log('[RPC] Daemon confirmed ready (authenticated, loopback).');
              resolve();
            })
            .catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        const errLog = data.toString().trim();
        if (errLog) {
          console.error(`[RPC-ERR] ${errLog}`);
          this.emitLog('RPC', 'error', errLog);
        }
      });

      proc.on('close', (code) => {
        if (aborted() || this.rpcProcess !== proc) { resolve(); return; }   // stale process
        this.rpcProcess = null;
        clearLive();
        if (!settled) {
          settled = true;
          const msg = `RPC Process exited before it was ready (Code: ${code ?? 'signal'}).`;
          this.emitLog('RPC', 'error', msg);
          reject(new Error(msg));
        } else {
          // A post-ready exit (crash, kill) must not leave a dead endpoint marked live; the next
          // startMoneroRpc launches a fresh process on a fresh port.
          const msg = `RPC Process exited (Code: ${code ?? 'signal'}).`;
          console.error(`[RPC] ${msg}`);
          this.emitLog('RPC', 'error', msg);
        }
      });

      proc.on('error', (err) => fail(err));
    });
  }

  public killAll(): void {
    console.log('[DaemonManager] Executing physical disconnect and memory wipe...');
    // Invalidate any in-flight launch BEFORE killing: its probe/close callbacks must not publish an
    // endpoint after shutdown, and its caller must not be left waiting.
    if (this.pendingLaunch) this.pendingLaunch.cancelled = true;
    this.pendingLaunch = null;
    // Free the in-flight slot NOW: an immediate restart must launch fresh instead of inheriting the
    // cancelled promise (the old launch still aborts on its cancellation flag).
    this.rpcStarting = null;
    const pending = this.pendingReject;
    this.pendingReject = null;
    if (this.rpcProcess) {
      this.rpcProcess.kill();
      this.rpcProcess = null;
    }
    this.rpcEndpoint = null;
    this.removeRpcConfig();
    if (pending) pending(new Error('wallet RPC stopped'));
    if (this.torProcess) {
      this.torProcess.kill();
      this.torProcess = null;
    }
  }
}