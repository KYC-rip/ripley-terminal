/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import moneroTs from 'monero-ts';
import { type IStealthEngine, StealthStep, type StealthConfig, type StealthOrder, type StealthLogger, type IncomingTxStatus } from './types';

function applyTacticalPatches(lib: any) {
  try {
    if (lib.MoneroWalletFull) {
      lib.MoneroWalletFull.FS = (window as any).fs.promises;
    }
    if (lib.LibraryUtils) {
      if (!lib.LibraryUtils.getHttpClient()) {
        lib.LibraryUtils.setHttpClient(new lib.HttpClient());
      }
      try { lib.LibraryUtils.setFs((window as any).fs); } catch(e) {}
    }
  } catch (e: any) {
    console.warn("[Engine] Patching failed:", e.message);
  }
}

export class XmrStealthEngine implements IStealthEngine {
  private wallet: any = null; 
  private logger: StealthLogger;
  private step: StealthStep = StealthStep.IDLE;
  private stopFlag = false;
  private cachedAddress: string = '';
  private cachedMnemonic: string = '';
  private isSyncing = false;
  private identityId: string = 'primary';

  constructor(logger: StealthLogger = console.log) {
    this.logger = logger;
  }
  
  public async init(rpcUrl: string, password: string = "stealth_session", mnemonic?: string, subaddressIndex?: number, overrideHeight?: number, onHeightUpdate?: (h: number) => void, isStagenet: boolean = false, identityId: string = 'primary') {
    this.step = StealthStep.INITIALIZING;
    this.identityId = identityId;
    
    const lib = moneroTs;
    const networkType = isStagenet ? lib.MoneroNetworkType.STAGENET : lib.MoneroNetworkType.MAINNET;
    
    applyTacticalPatches(lib);
    
    this.logger(`🌀 Initializing Monero [${isStagenet ? 'STAGENET' : 'MAINNET'}] Engine...`, 'process');

    if (rpcUrl.endsWith('/')) rpcUrl = rpcUrl.slice(0, -1);

    try {
        let currentHeight = 0;
        try {
          const daemon = await lib.connectToDaemonRpc(rpcUrl);
          currentHeight = await Promise.race([
            daemon.getHeight(),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 20000))
          ]);
        } catch (e: any) {
          throw new Error(`Connection check failed: ${e.message}`);
        }

        const savedKeysData = await (window as any).api.readWalletFile(this.identityId);
        
        const walletConfig: any = {
          networkType,
          password: password,
          server: { uri: rpcUrl },
          fs: (window as any).fs, 
          proxyToWorker: true,
          // 🔥 NEW: Configure lookahead to discover existing subaddresses/accounts during restore
          accountLookahead: 3,
          subaddressLookahead: 50
        };

        if (savedKeysData && savedKeysData.length > 0) {
           this.logger("📂 Loading persistent vault...", 'process');
           walletConfig.keysData = new Uint8Array(savedKeysData);
           this.wallet = await lib.openWalletFull(walletConfig);
        } else {
           this.logger("🆕 Creating/Restoring vault...", 'process');
           let targetSeed = mnemonic;
           if (!targetSeed) {
              this.logger("🔐 Generating new Master Identity...", 'process');
              const tempWallet = await lib.createWalletFull({ networkType, password: "temp", proxyToWorker: true, fs: (window as any).fs });
              targetSeed = await tempWallet.getSeed();
              await tempWallet.close();
           }
           walletConfig.seed = targetSeed;
           // 🔥 FIX: Correctly handle 0 as a valid restore height
           walletConfig.restoreHeight = (overrideHeight !== undefined && !isNaN(overrideHeight)) 
              ? overrideHeight 
              : Math.max(0, currentHeight - 10);
           
           this.logger(`📅 Restore Height set to: ${walletConfig.restoreHeight}`, 'info');
           this.wallet = await lib.createWalletFull(walletConfig);
        }

        this.cachedMnemonic = await this.wallet!.getSeed();
        this.cachedAddress = await this.wallet!.getAddress(0, targetIndex || 0);

        this.logger(`🔗 Uplink established. Identity: ${this.identityId}`, 'success');
        await this.saveWalletToDisk();

        this.step = StealthStep.AWAITING_FUNDS;
        return { address: this.cachedAddress, restoreHeight: walletConfig.restoreHeight };

    } catch (e: any) {
        this.logger(`❌ INIT_FATAL: ${e.message}`, 'error');
        this.step = StealthStep.ERROR;
        throw e;
    }
  }

  public async startSyncInBackground(onHeightUpdate?: (h: number) => void) {
    if (this.isSyncing) return;
    try {
      await this.startSync(moneroTs, onHeightUpdate);
    } catch (e: any) {
      this.logger(`⚠️ Background Sync Suspended: ${e.message}`, 'warning');
    }
  }

  private async saveWalletToDisk() {
    if (!this.wallet) return;
    try {
      const walletData = await this.wallet.getData();
      await (window as any).api.writeWalletFile({ filename: this.identityId, buffer: walletData });
    } catch (e) {
      console.error("[Vault] Save Failed:", e);
    }
  }

  private async startSync(lib: any, onHeightUpdate?: (h: number) => void) {
    this.logger("📡 Initializing blockchain scan...", 'process');
    this.isSyncing = true;
    applyTacticalPatches(lib);

    const self = this;
    const listener = new (class extends lib.MoneroWalletListener {
      private _lastPercent: number = -1;
      private _lastSaveTime: number = 0;
      
      async onSyncProgress(height: number, start: number, end: number, percent: number, message: string) {
        if (onHeightUpdate) onHeightUpdate(height);
        const pFloat = percent * 100;
        const pInt = Math.floor(pFloat);
        
        if (pInt > this._lastPercent || Math.random() < 0.05) {
          // 🔥 Show more detail in log for user peace of mind
          self.logSync(`Scanning: ${pFloat.toFixed(1)}% [Block ${height}]`);
          this._lastPercent = pInt;
        }

        const now = Date.now();
        if (now - this._lastSaveTime > 30000) {
          await self.saveWalletToDisk();
          this._lastSaveTime = now;
        }
      }

      async onNewBlock(height: number) {
        if (onHeightUpdate) onHeightUpdate(height);
        self.logSync(`New block: ${height}`);
        await self.saveWalletToDisk();
      }

      async onBalancesChanged(newBalance: bigint, newUnlockedBalance: bigint) {
        self.logSync(`Balance Updated: ${Number(newBalance)/1e12} XMR`);
        await self.saveWalletToDisk();
      }

      async onOutputReceived(output: any) { self.logSync("Output received."); await self.saveWalletToDisk(); }
      async onOutputSpent(output: any) { self.logSync("Output spent."); await self.saveWalletToDisk(); }
    })();

    try {
      this.logSync("Syncing: 0.1%");
      await this.wallet!.sync(listener);
      this.logger("✅ Wallet Fully Synced", 'success');
      await this.saveWalletToDisk();
    } catch (e: any) {
      this.logger(`❌ Sync Failed: ${e.message}`, 'error');
      throw e;
    } finally {
      this.isSyncing = false;
    }
  }

  public async createNextSubaddress(label: string = "Terminal Receive") {
    if (!this.wallet) throw new Error("Wallet not initialized");
    const sub = await this.wallet.createSubaddress(0, label);
    await this.saveWalletToDisk(); 
    return sub.getAddress();
  }

  public async getSubaddresses() {
    if (!this.wallet) return [];
    try {
      const subs = await this.wallet.getSubaddresses(0);
      return subs.map((s: any) => ({
        index: s.getIndex(),
        address: s.getAddress(),
        label: s.getLabel() || 'NO_LABEL',
        balance: (Number(s.getBalance()) / 1e12).toFixed(12),
        unlockedBalance: (Number(s.getUnlockedBalance()) / 1e12).toFixed(12),
        isUsed: s.getIsUsed()
      }));
    } catch (e) {
      console.error("Failed to fetch subaddresses", e);
      return [];
    }
  }

  public getAddress() { return this.cachedAddress; }
  public getMnemonic() { return this.cachedMnemonic; }
  public logSync(msg: string) { this.logger(msg, 'info'); }

  public async getHeight() {
    if (!this.wallet) return 0;
    try { return await this.wallet.getHeight(); } catch (e) { return 0; }
  }

  public async getBalance() {
    if (!this.wallet) return { total: '0.0', unlocked: '0.0' };
    try {
      const balance = await this.wallet.getBalance();
      const unlocked = await this.wallet.getUnlockedBalance();
      return { 
        total: (Number(balance) / 1e12).toFixed(12), 
        unlocked: (Number(unlocked) / 1e12).toFixed(12) 
      };
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
    await this.saveWalletToDisk();
    return tx.getHash();
  }

  public async churn(subaddressIndex: number = 0) {
    if (!this.wallet) throw new Error("Wallet not initialized");
    const address = await this.wallet.getAddress(0, subaddressIndex);
    const balance = await this.wallet.getUnlockedBalance(0);
    if (balance <= 0n) throw new Error("NO_UNLOCKED_FUNDS");
    this.logger(`🌪️ Initiating Churn: Sending ${Number(balance)/1e12} XMR to self...`, 'process');
    const txs = await this.wallet.sweepUnlocked({ address, accountIndex: 0, relay: true });
    await this.saveWalletToDisk();
    return txs[0].getHash();
  }

  public async getOutputs() {
    if (!this.wallet) return [];
    try {
      const outputs = await this.wallet.getOutputs({ isSpent: false });
      return outputs.map((o: any) => ({
        amount: (Number(o.getAmount()) / 1e12).toFixed(12),
        index: o.getIndex(),
        keyImage: o.getKeyImage()?.getHex(),
        isUnlocked: o.isUnlocked(),
        isFrozen: o.isLocked(), 
        subaddressIndex: o.getSubaddressIndex(),
        timestamp: o.getTx().getTimestamp() * 1000
      })).sort((a: any, b: any) => b.timestamp - a.timestamp);
    } catch (e) { return []; }
  }

  public async rescan(height: number) {
    if (!this.wallet) throw new Error("Wallet not initialized");
    this.logger(`🔄 Rescanning from height ${height}...`, 'process');
    try {
      await this.wallet.setSyncHeight(height);
      await this.wallet.rescanSpent();
      await this.wallet.rescanBlockchain();
      await this.saveWalletToDisk();
    } catch (e: any) { throw e; }
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
    } catch (e) { return []; }
  }

  public stop() { this.stopFlag = true; this.step = StealthStep.IDLE; }
}
