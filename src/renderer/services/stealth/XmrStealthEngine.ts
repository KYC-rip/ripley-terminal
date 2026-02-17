/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import moneroTs from 'monero-ts';
import { type IStealthEngine, StealthStep, type StealthLogger } from './types';
import { UpdateListener } from './UpdateListener';

function applyTacticalPatches(lib: any) {
  try {
    // 1. FS Patch for Main Thread
    if (lib.MoneroWalletFull && !lib.MoneroWalletFull.FS) {
      lib.MoneroWalletFull.FS = (window as any).fs?.promises;
    }

    if (lib.LibraryUtils && typeof lib.LibraryUtils.setHttpClient === 'function') {
      try {
        const client = lib.HttpClient?.request ? lib.HttpClient : new (lib.HttpClient || Object)();
        lib.LibraryUtils.setHttpClient(client);
      } catch (e) { /* Squelch */ }
    }
  } catch (e) {
    console.error("[StealthEngine] Patch failed:", e);
  }
}

export class XmrStealthEngine implements IStealthEngine {
  private wallet: moneroTs.MoneroWalletFull | null = null;
  private daemon: moneroTs.MoneroDaemonRpc | null = null;
  public logger: StealthLogger;
  private step: StealthStep = StealthStep.IDLE;
  private identityId: string = 'primary';
  private isSyncing = false;
  private updateListener?: UpdateListener;

  constructor(logger: StealthLogger = console.log) {
    this.logger = logger;
  }

  public async init(rpcUrl: string, password: string = "stealth_session", mnemonic?: string, subaddressIndex?: number, overrideHeight?: number, updateListener?: UpdateListener, isStagenet: boolean = false, identityId: string = 'primary') {
    this.step = StealthStep.INITIALIZING;
    this.identityId = identityId;
    this.updateListener = updateListener;

    applyTacticalPatches(moneroTs);

    this.logger(`🌀 Initializing Identity: ${this.identityId}`, 'process');

    try {
      // --- 1. Network Probe (Always on main thread) ---
      this.daemon = await moneroTs.connectToDaemonRpc({ server: { uri: rpcUrl }, proxyToWorker: true });
      const currentHeight = await Promise.race([
        this.daemon.getHeight(),
        new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Node_Unreachable")), 15000))
      ]);
      this.logger(`🟢 Uplink stable at height ${currentHeight}`, 'success');

      // --- 2. Raw Binary Retrieval ---
      const rawData = await window.api.readWalletFile(this.identityId);

      const walletConfig: Partial<moneroTs.MoneroWalletConfig> = {
        networkType: isStagenet ? moneroTs.MoneroNetworkType.STAGENET : moneroTs.MoneroNetworkType.MAINNET,
        password,
        server: { uri: rpcUrl },
        proxyToWorker: true, // 🚀 RE-ENABLED: Better performance & UI responsiveness
        accountLookahead: 3,
        subaddressLookahead: 50
      };

      if (rawData && rawData.length >= 2) {
        this.logger(`📂 Accessing encrypted vault file...`, 'process');
        walletConfig.keysData = new Uint8Array(rawData[0] as any);
        walletConfig.cacheData = new Uint8Array(rawData[1] as any);

        this.wallet = await Promise.race([
          moneroTs.openWalletFull(walletConfig),
          new Promise((_, reject) => setTimeout(() => reject(new Error("VAULT_OPEN_TIMEOUT: Decryption engine stalled.")), 25000))
        ]) as any;
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

      if (!this.wallet) {
        throw new Error("Wallet initialization failed");
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

  public async startSyncInBackground() {
    if (this.isSyncing || !this.wallet) return;
    this.isSyncing = true;

    const listener = this.updateListener;
    this.logger("🔄 Background Sync Service Started", 'process');

    try {
      if (listener) await this.wallet.addListener(listener);

      // Start background timer first
      await this.wallet.startSyncing(5000);

      // 🛡️ TACTICAL REINFORCEMENT: Manual Push Interval
      // Some environments (Worker/WASM) fail to trigger events reliably.
      // We manually poll the heights and push to the listener.
      const pushInterval = setInterval(async () => {
        if (!this.wallet || !this.isSyncing) {
          clearInterval(pushInterval);
          return;
        }

        try {
          // Get total from un-proxied daemon (fast, non-blocking)
          const total = await Promise.race([
            this.daemon!.getHeight(),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Node_Unreachable")), 15000))
          ]);

          // Get wallet height with strict timeout to avoid hanging the loop
          const height = await Promise.race([
            this.wallet!.getHeight(),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 1500))
          ]);

          if (listener && height > 0) {
            const percent = total > 0 ? (height / total) : 0;
            // Manually trigger listener method to drive UI
            if (listener.onSyncProgress) {
              listener.onSyncProgress(height, 0, total, percent, "HEARTBEAT_PUSH");
            }
          }
        } catch (e: any) {
          console.error(e);
          // Squelch expected "busy" or "timeout" errors during active sync
        }
      }, 3000);

      this.logger("✅ Sync heartbeat active.", 'success');
    } catch (e: any) {
      this.isSyncing = false;
      this.logger(`❌ Sync service failed: ${e.message}`, 'error');
    }
  }

  private async saveWalletToDisk() {
    if (!this.wallet) return;
    try {
      const walletData = await this.wallet.getData();
      let safePayload: number[][];

      if (Array.isArray(walletData)) {
        // Handle [keys, cache] array
        safePayload = walletData.map(d => Array.from(new Uint8Array(d as any)));
      } else {
        // Handle single Uint8Array
        safePayload = [Array.from(new Uint8Array(walletData as any))];
      }

      if (safePayload.length > 0) {
        await window.api.writeWalletFile({ filename: this.identityId, data: safePayload });
      }
    } catch (e) {
      console.error("[Vault] Binary save failed:", e);
    }
  }

  public async getNetworkHeight() {
    if (!this.wallet) throw new Error("Wallet not initialized");
    try {
      return await this.wallet.getDaemonHeight();
    } catch (e) { return 0; }
  }

  public async createNextSubaddress(label: string = "Terminal Receive") {
    if (!this.wallet) throw new Error("Wallet not initialized");
    const sub = await this.wallet.createSubaddress(0, label);
    await this.saveWalletToDisk();
    return sub.getAddress();
  }

  public async setSubaddressLabel(index: number, label: string) {
    if (!this.wallet) throw new Error("Wallet not initialized");
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
    if (!this.wallet) throw new Error("Wallet not initialized");
    await this.wallet.setRestoreHeight(height);
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
  public stop() { if (this.wallet) this.wallet.stopSyncing(); }
}
