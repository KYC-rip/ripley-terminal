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

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  public start(): void {
    if (this.intervalId) return;
    console.log('[Watcher] 👁️ Pulse monitoring started...');
    this.lastStoreTime = Date.now();
    this.intervalId = setInterval(async () => {
      await this.checkSyncStatus();
      await this.checkBalance();
      await this.periodicStore();
    }, 5000);
  }

  public stop(): void {
    if (this.intervalId) clearInterval(this.intervalId);
    this.intervalId = null;
    this.lastKnownBalance = -1;
    this.lastKnownHeight = -1;
    console.log('[Watcher] 💤 Pulse monitoring suspended.');
  }

  private pushEvent(payload: WalletEventPayload) {
    if (!this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('wallet-event', payload);
    }
  }

  private async periodicStore(): Promise<void> {
    try {
      // Auto-save every 60 seconds to prevent progress loss
      if (Date.now() - this.lastStoreTime > 60000) {
        await (WalletManager as any).callRpc('store', {});
        this.lastStoreTime = Date.now();
        console.log('[Watcher] 💾 Auto-saving wallet sync progress');
      }
    } catch (e) { /* Ignore */ }
  }

  private async checkSyncStatus(): Promise<void> {
    try {
      // 1. Refresh daemon height actively so the UI progress percentage is accurate
      const daemonHeight = await NodeManager.fetchDaemonHeight();

      // 2. Refresh local wallet height
      const result = await (WalletManager as any).callRpc('get_height');
      if (result.height !== this.lastKnownHeight) {
        this.lastKnownHeight = result.height;
        console.log(`[Watcher] 🔄 Detected block height update: ${result.height} / Latest daemon height: ${daemonHeight}`);
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
        console.log(`[Watcher] 💰 Detected balance change: ${result.balance}`);
        this.pushEvent({ type: 'BALANCE_CHANGED', payload: { balance: result.balance, unlocked: result.unlocked_balance } });
      }
      this.lastKnownBalance = result.balance;
    } catch (e) { /* Ignore */ }
  }
}