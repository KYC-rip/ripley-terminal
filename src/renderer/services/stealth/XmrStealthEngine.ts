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

    // 2. Set Worker Loader (Critical for desktop environment)
    if (lib.LibraryUtils && !lib.LibraryUtils.getWorkerLoader()) {
      console.log("[StealthEngine] 🛠️ Setting Worker Loader...");
      lib.LibraryUtils.setWorkerLoader(() => {
        return new Worker(new URL("/monero.worker.js", window.location.origin));
      });
    }

    // 3. HTTP Client Patch (Critical for proxyToWorker: false / direct daemon calls)
    if (lib.HttpClient) {
      if (typeof lib.HttpClient === 'function' && typeof lib.HttpClient.request !== 'function') {
        console.log("[StealthEngine] 🔧 Instantiating HttpClient for Wasm glue...");
        try {
          lib.HttpClient = new lib.HttpClient();
        } catch (e) {
          console.warn("[StealthEngine] HttpClient init warning:", e);
        }
      }
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
      // --- 1. Background Daemon Connection (Non-blocking for existing wallets) ---
      moneroTs.connectToDaemonRpc({ server: { uri: rpcUrl }, proxyToWorker: false })
        .then(d => { this.daemon = d; })
        .catch(() => { console.warn("[StealthEngine] Background daemon probe failed."); });

      // --- 2. Raw Binary Retrieval ---
      const rawData = await window.api.readWalletFile(this.identityId);

      const walletConfig: Partial<moneroTs.MoneroWalletConfig> = {
        networkType: isStagenet ? moneroTs.MoneroNetworkType.STAGENET : moneroTs.MoneroNetworkType.MAINNET,
        password,
        server: { uri: rpcUrl },
        proxyToWorker: true,
        accountLookahead: 3,
        subaddressLookahead: 50,
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
        
        // Only for NEW wallets, we try to get the height to set a restore point
        let currentHeight = 0;
        try {
          const tempDaemon = await moneroTs.connectToDaemonRpc({ server: { uri: rpcUrl }, proxyToWorker: false });
          currentHeight = await tempDaemon.getHeight();
        } catch (e) {
          this.logger("⚠️ Node unreachable, defaulting restore height to 0", "warning");
        }

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

      if (!this.wallet) throw new Error("Wallet initialization failed");

      const address = await this.wallet.getAddress(0, subaddressIndex || 0);
      this.logger(`🔗 Identity online: ${address.substring(0, 12)}...`, 'success');

      await this.saveWalletToDisk();
      this.step = StealthStep.AWAITING_FUNDS;

      return { address, restoreHeight: walletConfig.restoreHeight, networkHeight: 0 }; // Return 0, let sync fill it in
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
      // 🛡️ TACTICAL REINFORCEMENT: Manual Push Interval
      // Using the un-proxied daemon ensures total height is always available.
      // Racing the wallet height prevents synchronization deadlocks.
      let lastSavedHeight = 0;
      const pushInterval = setInterval(async () => {
        if (!this.wallet || !this.isSyncing) {
          clearInterval(pushInterval);
          return;
        }

        try {
          // Get total from un-proxied daemon (fast, non-blocking)
          const total = this.daemon ? await this.daemon.getHeight() : 0;

          // Get wallet height with strict timeout to avoid hanging the loop
          const height = await Promise.race([
            this.wallet!.getHeight(),
            new Promise<number>((_, reject) => setTimeout(() => reject(new Error("Timeout")), 2000))
          ]);

          if (listener && height > 0) {
            const percent = total > 0 ? (height / total) : 0;
            // Manually trigger listener method to drive UI
            if (listener.onSyncProgress) {
              listener.onSyncProgress(height, 0, total, percent, "HEARTBEAT_PUSH");
            }

            // Periodic save: Every 500 blocks or if we haven't saved in a while
            if (height - lastSavedHeight >= 500) {
              await this.saveWalletToDisk();
              lastSavedHeight = height;
            }
          }
        } catch (e: any) {
          // Squelch expected "busy" or "timeout" errors during active sync
        }
      }, 10000); // 🛡️ Slowed to 10s for Tor resilience

      // Perform initial catch-up sync (blocking in worker, non-blocking for UI)
      this.logger("📡 Performing initial catch-up...", 'process');
      await this.wallet.sync(listener);
      await this.saveWalletToDisk(); // Save after catch-up

      if (listener) await this.wallet.addListener(listener);

      console.log(this.wallet.getListeners().forEach((l) => console.log(l)));
      
      // Start background timer for continuous polling
      await this.wallet.startSyncing(10000);

      this.logger("✅ Sync cycle active.", 'success');
    } catch (e: any) {
      this.isSyncing = false;
      this.logger(`❌ Sync service failed: ${e.message}`, 'error');
    }
  }

  public async save() {
    await this.saveWalletToDisk();
  }

  public async saveWalletToDisk() {
    if (!this.wallet) return;
    try {
      const walletData = await this.wallet.getData();
      
      // monero-ts returns Uint8Array or [Uint8Array, Uint8Array]
      if (Array.isArray(walletData)) {
        // Send as array of Uint8Arrays, which Electron IPC can handle efficiently
        const binaryPayload = walletData.map(d => new Uint8Array(d as any));
        await window.api.writeWalletFile({ filename: this.identityId, data: binaryPayload as any });
      } else {
        const binaryPayload = new Uint8Array(walletData as any);
        await window.api.writeWalletFile({ filename: this.identityId, data: [binaryPayload] as any });
      }
      console.log(`[Vault] Binary save successful for ${this.identityId}`);
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

  public async shutdown() {
    this.isSyncing = false;
    this.logger("🛑 Shutting down Stealth Engine...", 'process');

    try {
      if (this.wallet) {
        // 1. Stop active background syncing
        await this.wallet.stopSyncing();
        
        // 2. Perform one final state persistence
        await this.saveWalletToDisk();
        
        // 3. Gracefully close the Wasm wallet instance
        await this.wallet.close(true);
        this.wallet = null;
      }

      // 4. Terminate background workers (Library-wide)
      // This is critical in Electron to prevent ghost processes.
      if ((moneroTs as any).LibraryUtils?.shutdown) {
        await (moneroTs as any).LibraryUtils.shutdown();
      }
      
      this.logger("✅ Engine offline.", 'success');
    } catch (e: any) {
      this.logger(`⚠️ Shutdown notice: ${e.message}`, 'warning');
    }
  }

  public stop() { 
    this.isSyncing = false;
    if (this.wallet) this.wallet.stopSyncing(); 
  }
}
