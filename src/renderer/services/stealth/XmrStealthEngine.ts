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
  public onStatusChange?: (status: StealthStep) => void;

  constructor(logger: StealthLogger = console.log) {
    this.logger = logger;
  }

  private setStep(step: StealthStep) {
    this.step = step;
    if (this.onStatusChange) this.onStatusChange(step);
  }

  public async init(rpcUrl: string, password: string = "stealth_session", mnemonic?: string, subaddressIndex?: number, overrideHeight?: number, updateListener?: UpdateListener, isStagenet: boolean = false, identityId: string = 'primary') {
    this.setStep(StealthStep.INITIALIZING);
    this.identityId = identityId;
    this.updateListener = updateListener;

    applyTacticalPatches(moneroTs);

    this.logger(`🌀 Initializing Identity: ${this.identityId}`, 'process');

    try {
      // --- 1. Raw Binary Retrieval ---
      const rawData = await window.api.readWalletFile(this.identityId);
      
      // 🛡️ TACTICAL DECISION: If a mnemonic is provided, we are in RESTORE/NEW mode.
      // We MUST ignore existing cache data, otherwise monero-ts will prioritize
      // the height stored in the cache (which might be 0) over our restoreHeight.
      const isRestore = !!mnemonic;
      const keysData = (rawData && rawData.length >= 1) ? new Uint8Array(rawData[0] as any) : null;
      const cacheData = (rawData && rawData.length >= 2 && !isRestore) ? new Uint8Array(rawData[1] as any) : null;

      // --- 2. Daemon Connection (Try to get height, but don't block restoration on failure) ---
      try {
        this.daemon = await moneroTs.connectToDaemonRpc({ server: { uri: rpcUrl }, proxyToWorker: false });
      } catch (e) {
        console.warn("[StealthEngine] Daemon unreachable during init/restore. Proceeding in offline mode.");
      }

      const walletConfig: Partial<moneroTs.MoneroWalletConfig> = {
        networkType: isStagenet ? moneroTs.MoneroNetworkType.STAGENET : moneroTs.MoneroNetworkType.MAINNET,
        password,
        server: { uri: rpcUrl },
        proxyToWorker: true,
        accountLookahead: 25,
        subaddressLookahead: 50,
      };

      if (keysData && cacheData) {
        this.logger(`📂 Accessing encrypted vault file...`, 'process');
        walletConfig.keysData = keysData;
        walletConfig.cacheData = cacheData;
        this.wallet = await moneroTs.openWalletFull(walletConfig);
      } else {
        this.logger(isRestore ? "🌅 Restoring cryptographic identity..." : "🆕 Constructing fresh keys...", 'process');
        
        let currentHeight = 0;
        if (this.daemon) {
          try {
            currentHeight = await this.daemon.getHeight();
          } catch (e) {
            console.warn("[StealthEngine] Could not fetch current height from daemon.");
          }
        }

        let targetSeed = mnemonic;

        if (!targetSeed) {
          // If no seed and no cache, this is an error state or a new random wallet
          const tempWallet = await moneroTs.createWalletFull({ ...walletConfig, proxyToWorker: false, password: "temp" });
          targetSeed = await tempWallet.getSeed();
          await tempWallet.close();
        }

        walletConfig.seed = targetSeed;
        walletConfig.restoreHeight = (overrideHeight !== undefined && !isNaN(overrideHeight))
          ? overrideHeight
          : (currentHeight > 0 ? Math.max(0, currentHeight - 1000) : 0);

        // If we have keysData but no cacheData (e.g. forced restore), use keysData
        if (keysData) walletConfig.keysData = keysData;

        this.wallet = await moneroTs.createWalletFull(walletConfig);
        
        // 🛡️ DOUBLE PROTECTION: Explicitly set the sync height after creation
        if (walletConfig.restoreHeight > 0) {
          await this.wallet.setRestoreHeight(walletConfig.restoreHeight).catch(() => {});
        }
      }

      if (!this.wallet) throw new Error("Wallet initialization failed");

      const address = await this.wallet.getAddress(0, subaddressIndex || 0);
      this.logger(`🔗 Identity online: ${address.substring(0, 12)}...`, 'success');

      await this.saveWalletToDisk();
      this.setStep(StealthStep.AWAITING_FUNDS);

      return { address, restoreHeight: walletConfig.restoreHeight, networkHeight: 0 }; // Return 0, let sync fill it in
    } catch (e: any) {
      this.logger(`❌ FATAL: ${e.message}`, 'error');
      this.setStep(StealthStep.ERROR);
      throw e;
    }
  }

  public async startSyncInBackground() {
    if (this.isSyncing || !this.wallet) return;
    this.isSyncing = true;
    this.setStep(StealthStep.SYNCING);

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
            if (height - lastSavedHeight >= 100) {
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
      this.setStep(StealthStep.ERROR);
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
      const accounts = await this.wallet.getAccounts();
      let total = BigInt(0);
      let unlocked = BigInt(0);
      for (const acc of accounts) {
        total += BigInt(acc.getBalance().toString());
        unlocked += BigInt(acc.getUnlockedBalance().toString());
      }
      return { total: (Number(total) / 1e12).toFixed(12), unlocked: (Number(unlocked) / 1e12).toFixed(12) };
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

  public async getRestoreHeight() {
    if (!this.wallet) throw new Error("Wallet not initialized");
    try {
      return await this.wallet.getRestoreHeight();
    } catch (e) { return 0; }
  }

  public async rescan(height: number) {
    if (!this.wallet) throw new Error("Wallet not initialized");
    
    this.logger(`🔄 Preparing rescan from height ${height}...`, 'process');
    
    // 1. Stop background sync to prevent deadlocks
    this.isSyncing = false;
    await this.wallet.stopSyncing();

    try {
      // 2. Set new restore height
      await this.wallet.setRestoreHeight(height);
      
      this.logger(`📡 Rescan initiated. This may take a few minutes...`, 'process');
      
      // 3. Trigger the actual scan
      // Note: We use the listener to get progress updates
      await this.wallet.rescanBlockchain();
      
      this.logger(`✅ Rescan complete. Resuming background sync.`, 'success');
      
      // 4. Persistence
      await this.saveWalletToDisk();
      
      // 5. Restart background sync
      this.startSyncInBackground();
    } catch (e: any) {
      this.logger(`❌ Rescan failed: ${e.message}`, 'error');
      this.startSyncInBackground(); // Try to recover
      throw e;
    }
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
        await this.wallet.stopSyncing().catch(() => {});
        
        // 2. Perform one final state persistence via IPC
        // We do this BEFORE closing to ensure we have access to the wallet data.
        await this.saveWalletToDisk().catch(e => {
          console.error("[StealthEngine] Final save failed during shutdown:", e);
        });
        
        // 3. Gracefully close the Wasm wallet instance and free memory.
        // We pass 'false' because we've already manually handled the save via IPC.
        await this.wallet.close(false);
        this.wallet = null;
      }

      // 4. Terminate background workers (Library-wide)
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
