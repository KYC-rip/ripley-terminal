import { BrowserWindow } from 'electron';
import { WalletManager } from './WalletManager';
import { NodeManager } from './NodeManager';
import { WalletEventPayload } from './types';

export class SyncWatcher {
  private mainWindow: BrowserWindow;
  private intervalId: NodeJS.Timeout | null = null;
  private lastKnownBalance: number = -1;
  private lastKnownHeight: number = -1;
  private lastStoreTime: number = 0;
  private onLog?: (source: string, level: 'info' | 'error', message: string) => void;

  constructor(mainWindow: BrowserWindow, onLog?: (source: string, level: 'info' | 'error', message: string) => void) {
    this.mainWindow = mainWindow;
    this.onLog = onLog;
  }

  public start(): void {
    if (this.intervalId) return;
    this.emitLog('Watcher', 'info', '👁️ Pulse monitoring started...');
    this.lastStoreTime = Date.now();
    this.intervalId = setInterval(async () => {
      await this.checkSyncStatus();
      await this.checkBalance();
      await this.periodicStore();
    }, 5000);
  }

  public getSnapshot() {
    return {
      balance: this.lastKnownBalance,
      height: this.lastKnownHeight,
    };
  }

  public stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.lastKnownBalance = -1;
    this.lastKnownHeight = -1;
    this.emitLog('Watcher', 'info', '💤 Pulse monitoring suspended.');
  }

  private pushEvent(payload: WalletEventPayload) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('wallet-event', payload);
    }
  }

  private async periodicStore(): Promise<void> {
    try {
      if (Date.now() - this.lastStoreTime > 60000) {
        await (WalletManager as any).callRpc('store', {});
        this.lastStoreTime = Date.now();
        this.emitLog('Watcher', 'info', '💾 Auto-saving wallet sync progress');
      }
    } catch (e) { /* Ignore */ }
  }

  private emitLog(source: string, level: 'info' | 'error', message: string) {
    console.log(`[${source}] ${message}`);
    if (this.onLog) this.onLog(source, level, message);
  }

  private async checkSyncStatus(): Promise<void> {
    try {
      // 1. Refresh daemon height actively so the UI progress percentage is accurate
      const daemonHeight = await NodeManager.fetchDaemonHeight();

      // 2. Refresh local wallet height
      const result = await (WalletManager as any).callRpc('get_height');
      if (result.height !== this.lastKnownHeight) {
        this.lastKnownHeight = result.height;
        this.emitLog('Watcher', 'info', `🔄 Block height update: ${result.height} / Daemon: ${daemonHeight}`);
        this.pushEvent({
          type: 'SYNC_UPDATE', payload: {
            height: result.height,
            daemonHeight: daemonHeight
          }
        });
      }
    } catch (e) { /* Ignore */ }
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