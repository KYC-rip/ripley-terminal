import { BrowserWindow } from 'electron';
import { WalletManager } from './WalletManager';
import { NodeManager } from './NodeManager';
import { WalletEventPayload } from './types';

export class SyncWatcher {
  private mainWindow: BrowserWindow;
  private intervalId: NodeJS.Timeout | null = null;
  private lastKnownBalance: number = -1;
  private lastKnownHeight: number = -1;
  private onLog?: (source: string, level: 'info' | 'error', message: string) => void;
  private loopCounter: number = 0;

  // Daemon height cache — no need to hit the remote node every 2s
  private cachedDaemonHeight: number = 0;
  private lastDaemonHeightFetch: number = 0;
  private static readonly DAEMON_HEIGHT_TTL = 60_000; // 60 seconds

  // Adaptive polling intervals
  private static readonly SYNCING_INTERVAL = 2_000;   // 2s when behind > 5 blocks
  private static readonly IDLE_INTERVAL = 10_000;       // 10s when gap <= 5 blocks

  // Track last daemon height to skip get_height when nothing changed
  private lastEmittedDaemonHeight: number = 0;

  // Padded sync state
  private isSyncing: boolean = false;

  // Pause flag — prevents RPC contention during tx construction
  private paused: boolean = false;

  constructor(mainWindow: BrowserWindow, onLog?: (source: string, level: 'info' | 'error', message: string) => void) {
    this.mainWindow = mainWindow;
    this.onLog = onLog;
  }

  public start(): void {
    // Reset state for new wallet (handles soft-lock → new wallet scenario)
    this.lastKnownHeight = -1;
    this.lastKnownBalance = -1;
    this.cachedDaemonHeight = 0;
    this.lastDaemonHeightFetch = 0;
    this.isSyncing = false;

    if (this.intervalId) {
      this.emitLog('Watcher', 'info', '🔄 Watcher reset for new wallet');
      return; // Poll loop already running, it will pick up the new wallet
    }
    this.emitLog('Watcher', 'info', '👁️ Pulse monitoring started...');
    this.loopCounter = 0;
    this.intervalId = setTimeout(() => this.runLoop(), 0);
  }

  private async runLoop(): Promise<void> {
    try {
      if (!this.intervalId) return;

      if (this.paused) return;

      // 1. Check daemon height (cached 60s, skip if not advanced)
      const daemonHeight = await this.getDaemonHeight();

      // 2. Only check wallet height if daemon has advanced since last emit
      let walletHeight = 0;
      if (daemonHeight > this.lastEmittedDaemonHeight) {
        walletHeight = await (WalletManager as any).callRpc('get_height').catch(() => 0);
      }

      // 3. Track sync state based on gap
      if (daemonHeight > 0 && walletHeight > 0) {
        const gap = daemonHeight - walletHeight;
        if (gap > 5 && !this.isSyncing) {
          this.isSyncing = true;
          this.emitLog('Sync', 'info', `📦 ${gap} blocks behind — wallet auto-refresh is scanning...`);
        } else if (gap <= 5 && this.isSyncing) {
          this.isSyncing = false;
          this.emitLog('Sync', 'info', `✅ Sync complete at block ${walletHeight}`);
        }

        // Emit update only when heights actually changed
        if (walletHeight !== this.lastKnownHeight || daemonHeight !== this.lastEmittedDaemonHeight) {
          this.lastKnownHeight = walletHeight;
          this.lastEmittedDaemonHeight = daemonHeight;
          this.pushEvent({ type: 'SYNC_UPDATE', payload: { height: walletHeight, daemonHeight } });
        }
      }

      // 4. Periodic balance check every 3 cycles (~6s) or first time
      this.loopCounter++;
      if (this.loopCounter % 3 === 0 || this.lastKnownBalance === -1) {
        await this.checkBalance();
      }
    } catch (e) {
      /* Loop resilience */
    } finally {
      if (this.intervalId !== null) {
        const interval = this.isSyncing ? SyncWatcher.SYNCING_INTERVAL : SyncWatcher.IDLE_INTERVAL;
        this.intervalId = setTimeout(() => this.runLoop(), interval);
      }
    }
  }

  public getSnapshot() {
    return {
      balance: this.lastKnownBalance,
      height: this.lastKnownHeight,
    };
  }

  public pause(): void {
    this.paused = true;
    this.emitLog('Watcher', 'info', '⏸️ Polling paused (tx in progress)');
  }

  public resume(): void {
    this.paused = false;
    this.emitLog('Watcher', 'info', '▶️ Polling resumed');
  }

  public stop(): void {
    if (this.intervalId) {
      clearTimeout(this.intervalId);
    }
    this.intervalId = null;
    this.lastKnownBalance = -1;
    this.lastKnownHeight = -1;
    this.isSyncing = false;
    this.emitLog('Watcher', 'info', '💤 Pulse monitoring suspended.');
  }

  private pushEvent(payload: WalletEventPayload) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('wallet-event', payload);
    }
  }

  private emitLog(source: string, level: 'info' | 'error', message: string) {
    console.log(`[${source}] ${message}`);
    if (this.onLog) this.onLog(source, level, message);
  }

  // ─── Daemon Height with TTL Cache ───
  private async getDaemonHeight(): Promise<number> {
    const now = Date.now();
    if (now - this.lastDaemonHeightFetch < SyncWatcher.DAEMON_HEIGHT_TTL && this.cachedDaemonHeight > 0) {
      return this.cachedDaemonHeight;
    }
    try {
      const h = await NodeManager.fetchDaemonHeight();
      if (h > 0) {
        this.cachedDaemonHeight = h;
        this.lastDaemonHeightFetch = now;
      }
      return this.cachedDaemonHeight;
    } catch {
      return this.cachedDaemonHeight;
    }
  }

  private async checkBalance(): Promise<void> {
    try {
      const result = await (WalletManager as any).callRpc('get_balance');
      if (result.balance !== this.lastKnownBalance) {
        this.emitLog('Watcher', 'info', `💰 Balance change detected: ${result.balance}`);
        this.pushEvent({ type: 'BALANCE_CHANGED', payload: { balance: result.balance, unlocked: result.unlocked_balance } });
      }
      this.lastKnownBalance = result.balance;
    } catch (e) { /* Ignore */ }
  }
}
