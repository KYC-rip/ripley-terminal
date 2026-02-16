/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import moneroTs from 'monero-ts';
import { type IStealthEngine, StealthStep, type StealthConfig, type StealthOrder, type StealthLogger, type IncomingTxStatus } from './types';

export class XmrStealthEngine implements IStealthEngine {
  private wallet: moneroTs.MoneroWalletFull | null = null;
  private logger: StealthLogger;
  private step: StealthStep = StealthStep.IDLE;
  private stopFlag = false;
  private cachedAddress: string = '';
  private cachedMnemonic: string = '';
  private isSyncing = false;
  private lastLoggedBalance: string = '0.0';

  constructor(logger: StealthLogger = console.log) {
    this.logger = logger;
  }
  
  public async init(rpcUrl: string, mnemonic?: string, subaddressIndex?: number, overrideHeight?: number, onHeightUpdate?: (h: number) => void, isStagenet: boolean = false) {
    this.step = StealthStep.INITIALIZING;
    const lib = moneroTs;
    const networkType = isStagenet ? lib.MoneroNetworkType.STAGENET : lib.MoneroNetworkType.MAINNET;
    
    this.logger(`🌀 Initializing Monero [${isStagenet ? 'STAGENET' : 'MAINNET'}] Engine...`, 'process');

    if (rpcUrl.endsWith('/')) rpcUrl = rpcUrl.slice(0, -1);

    try {
        let currentHeight = 0;
        try {
          const daemon = await lib.connectToDaemonRpc(rpcUrl);
          currentHeight = await Promise.race([
            daemon.getHeight(),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 8000))
          ]);
        } catch (e: any) {
          throw new Error(`Connection check failed: ${e.message}`);
        }

        let targetSeed = mnemonic;
        let targetIndex = subaddressIndex || 0;

        if (!targetSeed) {
            this.logger("🔐 Generating new Master Identity...", 'process');
            const tempWallet = await lib.createWalletFull({ networkType });
            targetSeed = await tempWallet.getSeed();
            await tempWallet.close();
        }

        let restoreHeight = overrideHeight || currentHeight;
        const finalRestoreHeight = Math.max(0, restoreHeight - 10);

        const walletConfig: any = {
          networkType,
          password: "stealth_session",
          server: { uri: rpcUrl },
          seed: targetSeed,
          restoreHeight: finalRestoreHeight
        };

        this.wallet = await lib.createWalletFull(walletConfig);
        this.cachedMnemonic = targetSeed!;
        this.cachedAddress = await this.wallet.getAddress(0, targetIndex);

        this.logger(`🔗 Uplink established. Network: ${isStagenet ? 'STAGENET' : 'MAINNET'}`, 'success');

        await this.startSync(lib, onHeightUpdate);

        this.step = StealthStep.AWAITING_FUNDS;
        return { address: this.cachedAddress, restoreHeight: finalRestoreHeight };

    } catch (e: any) {
        this.step = StealthStep.ERROR;
        throw e;
    }
  }

  private async startSync(lib: any, onHeightUpdate?: (h: number) => void) {
    this.logger("📡 Syncing with blockchain...", 'process');
    this.isSyncing = true;

    const listener = new (class extends lib.MoneroWalletListener {
      private _parent: XmrStealthEngine;
      constructor(parent: XmrStealthEngine) { super(); this._parent = parent; }
      async onSyncProgress(height: number, _start: number, _end: number, percent: number) {
        if (onHeightUpdate) onHeightUpdate(height);
        if (Math.random() < 0.05) this._parent.logSync(`Syncing: ${(percent * 100).toFixed(1)}%`);
      }
      async onNewBlock(height: number) { if (onHeightUpdate) onHeightUpdate(height); }
      async onBalancesChanged() { }
      async onOutputReceived() { }
      async onOutputSpent() { }
    })(this);

    await this.wallet!.sync(listener);
    this.logger("✅ Wallet Fully Synced", 'success');
    this.isSyncing = false;
  }

  public async createNextSubaddress(label: string = "Terminal Receive") {
    if (!this.wallet) throw new Error("Wallet not initialized");
    const sub = await this.wallet.createSubaddress(0, label);
    return sub.getAddress();
  }

  public getAddress() { return this.cachedAddress; }
  public getMnemonic() { return this.cachedMnemonic; }
  public logSync(msg: string) { this.logger(msg, 'info'); }

  public async getBalance() {
    if (!this.wallet) return { total: '0.0', unlocked: '0.0' };
    try {
      if (!this.isSyncing) await this.wallet.sync();
      const balance = await this.wallet.getBalance();
      const unlocked = await this.wallet.getUnlockedBalance();
      const formattedBal = (Number(balance) / 1e12).toFixed(12);
      const formattedUnlocked = (Number(unlocked) / 1e12).toFixed(12);
      return { total: formattedBal, unlocked: formattedUnlocked };
    } catch (e) { return { total: '0.0', unlocked: '0.0' }; }
  }

  public async transfer(toAddress: string, amount: number): Promise<string> {
    if (!this.wallet) throw new Error("Wallet not initialized");
    const amountAtomic = BigInt((amount * 1e12).toFixed(0));
    const tx = await this.wallet.createTx({
      destinations: [{ address: toAddress, amount: amountAtomic }],
      accountIndex: 0,
      priority: moneroTs.MoneroTxPriority.DEFAULT,
      relay: true
    });
    return tx.getHash();
  }

  public async getTxs() {
    if (!this.wallet) return [];
    try {
      const transfers = await this.wallet.getTransfers();
      return transfers.map((t: any) => {
        const tx = t.getTx();
        return {
          id: tx.getHash(),
          amount: (Number(t.getAmount()) / 1e12).toFixed(4),
          isIncoming: t.getIsIncoming(),
          timestamp: tx.getTimestamp() * 1000,
          confirmations: tx.getNumConfirmations(),
          address: t.getAddress()
        };
      }).sort((a: any, b: any) => b.timestamp - a.timestamp);
    } catch (e) {
      console.error("Failed to fetch history", e);
      return [];
    }
  }

  public stop() { this.stopFlag = true; this.step = StealthStep.IDLE; }
}
