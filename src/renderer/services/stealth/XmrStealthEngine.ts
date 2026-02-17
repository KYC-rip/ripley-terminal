/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import moneroTs from 'monero-ts';
import { type IStealthEngine, StealthStep, type StealthConfig, type StealthOrder, type StealthLogger, type IncomingTxStatus } from './types';

function applyTacticalPatches(lib: any) {
  try {
    if (lib.MoneroWalletFull && !lib.MoneroWalletFull.FS) {
      lib.MoneroWalletFull.FS = (window as any).fs?.promises;
    }
    if (lib.LibraryUtils) {
      try {
        if (typeof lib.LibraryUtils.getHttpClient === 'function' && !lib.LibraryUtils.getHttpClient()) {
          lib.LibraryUtils.setHttpClient(new lib.HttpClient());
        }
      } catch (e) {}
    }
  } catch (e) {}
}

export class XmrStealthEngine implements IStealthEngine {
  private wallet: any = null; 
  private logger: StealthLogger;
  private step: StealthStep = StealthStep.IDLE;
  private identityId: string = 'primary';
  private isSyncing = false;

  constructor(logger: StealthLogger = console.log) {
    this.logger = logger;
  }
  
  public async init(rpcUrl: string, password: string = "stealth_session", mnemonic?: string, subaddressIndex?: number, overrideHeight?: number, onHeightUpdate?: (h: number) => void, isStagenet: boolean = false, identityId: string = 'primary') {
    this.step = StealthStep.INITIALIZING;
    this.identityId = identityId;
    
    applyTacticalPatches(moneroTs);
    
    this.logger(`🌀 Initializing Identity: ${this.identityId}`, 'process');

    try {
        // --- 1. Network Probe ---
        const daemon = await moneroTs.connectToDaemonRpc(rpcUrl);
        const currentHeight = await Promise.race([
          daemon.getHeight(),
          new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Node_Unreachable")), 15000))
        ]);
        this.logger(`🟢 Uplink stable at height ${currentHeight}`, 'success');

        // --- 2. Raw Binary Retrieval ---
        // 'rawData' is now a pure Uint8Array from Electron's structure clone
        const rawData = await (window as any).api.readWalletFile(this.identityId);
        
        const walletConfig: any = {
          networkType: isStagenet ? moneroTs.MoneroNetworkType.STAGENET : moneroTs.MoneroNetworkType.MAINNET,
          password,
          server: { uri: rpcUrl },
          proxyToWorker: true, // Worker is safe now as we aren't passing functions
          accountLookahead: 3,
          subaddressLookahead: 50
        };

        if (rawData && rawData.length > 0) {
           this.logger("📂 Accessing encrypted vault file...", 'process');
           // Directly pass the Uint8Array. No conversion, no corruption.
           walletConfig.keysData = rawData;
           this.wallet = await moneroTs.openWalletFull(walletConfig);
        } else {
           this.logger("🆕 Constructing fresh cryptographic keys...", 'process');
           let targetSeed = mnemonic;
           if (!targetSeed) {
              const tempWallet = await moneroTs.createWalletFull({ ...walletConfig, proxyToWorker: false, password: "temp" });
              targetSeed = await tempWallet.getSeed();
              await tempWallet.close();
           }
           walletConfig.seed = targetSeed;
           walletConfig.restoreHeight = (overrideHeight !== undefined && !isNaN(overrideHeight)) 
              ? overrideHeight 
              : Math.max(0, currentHeight - 10);
           
           this.wallet = await moneroTs.createWalletFull(walletConfig);
        }

        const address = await this.wallet.getAddress(0, subaddressIndex || 0);
        this.logger(`🔗 Identity online: ${address.substring(0, 12)}...`, 'success');
        
        await this.saveWalletToDisk();
        this.step = StealthStep.AWAITING_FUNDS;
        
        return { address, restoreHeight: walletConfig.restoreHeight };

    } catch (e: any) {
        this.logger(`❌ FATAL: ${e.message}`, 'error');
        this.step = StealthStep.ERROR;
        throw e;
    }
  }

  public async startSyncInBackground(onHeightUpdate?: (h: number) => void) {
    if (this.isSyncing || !this.wallet) return;
    this.isSyncing = true;
    try {
      await this.wallet.addListener(new (class extends moneroTs.MoneroWalletListener {
        async onSyncProgress(h: number, s: number, e: number, percent: number) {
          if (onHeightUpdate) onHeightUpdate(h);
        }
        async onNewBlock(h: number) {
          if (onHeightUpdate) onHeightUpdate(h);
        }
      })());

      // Polling fallback (Tactical reinforcement for UI responsiveness)
      const pollInterval = setInterval(async () => {
        if (!this.isSyncing || !this.wallet) {
          clearInterval(pollInterval);
          return;
        }
        try {
          const h = await this.wallet.getHeight();
          if (onHeightUpdate) onHeightUpdate(h);
        } catch (e) { /* Squelch */ }
      }, 2500);

      this.wallet.sync().then(() => {
        this.isSyncing = false;
        clearInterval(pollInterval);
        this.saveWalletToDisk();
        this.logger("✅ Ledger synchronized.", 'success');
      }).catch((e: any) => { 
        this.isSyncing = false; 
        clearInterval(pollInterval);
        this.logger(`❌ Sync interrupted: ${e.message}`, 'error');
      });
    } catch (e) { this.isSyncing = false; }
  }

  private async saveWalletToDisk() {
    if (!this.wallet) return;
    try {
      // getData() returns a pure Uint8Array
      const walletData = await this.wallet.getData();
      if (walletData && walletData.length > 0) {
        // Send pure binary to Main process via IPC
        await (window as any).api.writeWalletFile({ filename: this.identityId, data: walletData });
      }
    } catch (e) {
      console.error("[Vault] Binary save failed:", e);
    }
  }

  public async getNetworkHeight() {
    try {
      const daemon = await moneroTs.connectToDaemonRpc(this.wallet.getDaemonUri());
      return await daemon.getHeight();
    } catch (e) { return 0; }
  }

  public async createNextSubaddress(label: string = "Terminal Receive") {
    if (!this.wallet) throw new Error("Wallet not initialized");
    const sub = await this.wallet.createSubaddress(0, label);
    await this.saveWalletToDisk(); 
    return sub.getAddress();
  }

  public async setSubaddressLabel(index: number, label: string) {
    if (!this.wallet) throw new Error("NOT_INIT");
    await this.wallet.setSubaddressLabel(0, index, label);
    await this.saveWalletToDisk();
  }

  // --- Common Wrappers ---
  public async getSubaddresses() {
    if (!this.wallet) return [];
    try {
      const subs = await this.wallet.getSubaddresses(0);
      return subs.map((s: any) => ({
        index: s.getIndex(), address: s.getAddress(), label: s.getLabel() || 'NO_LABEL',
        balance: (Number(s.getBalance()) / 1e12).toFixed(12),
        unlockedBalance: (Number(s.getUnlockedBalance()) / 1e12).toFixed(12),
        isUsed: s.getIsUsed()
      }));
    } catch (e) { return []; }
  }

  public async getBalance() {
    if (!this.wallet) return { total: '0.0', unlocked: '0.0' };
    try {
      const balance = await this.wallet.getBalance();
      const unlocked = await this.wallet.getUnlockedBalance();
      return { total: (Number(balance) / 1e12).toFixed(12), unlocked: (Number(unlocked) / 1e12).toFixed(12) };
    } catch (e) { return { total: '0.0', unlocked: '0.0' }; }
  }

  public async transfer(toAddress: string, amount: number): Promise<string> {
    if (!this.wallet) throw new Error("NOT_INIT");
    const tx = await this.wallet.createTx({
      destinations: [{ address: toAddress, amount: BigInt((amount * 1e12).toFixed(0)) }],
      accountIndex: 0, relay: true
    });
    await this.saveWalletToDisk();
    return tx.getHash();
  }

  public async churn() {
    if (!this.wallet) throw new Error("NOT_INIT");
    const address = await this.wallet.getAddress(0, 0);
    const txs = await this.wallet.sweepUnlocked({ address, accountIndex: 0, relay: true });
    await this.saveWalletToDisk();
    return txs[0].getHash();
  }

  public async getOutputs() {
    if (!this.wallet) return [];
    try {
      const outputs = await this.wallet.getOutputs({ isSpent: false });
      return outputs.map((o: any) => ({
        amount: (Number(o.getAmount()) / 1e12).toFixed(12), index: o.getIndex(),
        keyImage: o.getKeyImage()?.getHex(), isUnlocked: o.isUnlocked(),
        isFrozen: o.isLocked(), subaddressIndex: o.getSubaddressIndex(),
        timestamp: o.getTx().getTimestamp() * 1000
      })).sort((a: any, b: any) => b.timestamp - a.timestamp);
    } catch (e) { return []; }
  }

  public async rescan(height: number) {
    if (!this.wallet) throw new Error("NOT_INIT");
    await this.wallet.setSyncHeight(height);
    await this.wallet.rescanSpent();
    await this.wallet.rescanBlockchain();
    await this.saveWalletToDisk();
  }

  public async getTxs() {
    if (!this.wallet) return [];
    try {
      const transfers = await this.wallet.getTransfers();
      return transfers.map((t: any) => {
        const tx = t.getTx();
        return {
          id: tx.getHash(), amount: (Number(t.getAmount()) / 1e12).toFixed(4),
          isIncoming: t.getIsIncoming(), timestamp: tx.getTimestamp() * 1000,
          confirmations: tx.getNumConfirmations(), address: t.getAddress()
        };
      }).sort((a: any, b: any) => b.timestamp - a.timestamp);
    } catch (e) { return []; }
  }

  public async getMnemonic() { return this.wallet ? await this.wallet.getSeed() : ''; }
  public async getHeight() { return this.wallet ? await this.wallet.getHeight() : 0; }
  public stop() { if(this.wallet) this.wallet.stopSyncing(); }
}
