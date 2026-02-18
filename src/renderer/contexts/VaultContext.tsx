import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { XmrStealthEngine } from '../services/stealth/XmrStealthEngine';
import moneroTs from 'monero-ts';
import { UpdateListener } from '../services/stealth/UpdateListener';

// 🔥 Tactical Patch
if (moneroTs.MoneroWalletFull) {
  (moneroTs as any).MoneroWalletFull.FS = (window as any).fs?.promises;
}

export interface Identity { id: string; name: string; created: number; }
export interface SubaddressInfo { index: number; address: string; label: string; balance: string; unlockedBalance: string; isUsed: boolean; }
export interface OutputInfo { amount: string; index: number; keyImage: string; isUnlocked: boolean; isFrozen: boolean; subaddressIndex: number; timestamp: number; }
export interface LogEntry { msg: string; timestamp: number; type?: 'info' | 'success' | 'warning' | 'process' | 'error'; }

interface VaultContextType {
  balance: { total: string; unlocked: string };
  address: string;
  subaddresses: SubaddressInfo[];
  outputs: OutputInfo[];
  status: string;
  logs: LogEntry[];
  txs: any[];
  currentHeight: number;
  totalHeight: number;
  syncPercent: number;
  isAppLoading: boolean;
  isInitializing: boolean;
  isLocked: boolean;
  isSending: boolean;
  hasVaultFile: boolean;
  identities: Identity[];
  activeId: string;
  isStagenet: boolean;
  unlock: (password: string, restoreSeed?: string, restoreHeight?: number, newIdentityName?: string) => Promise<void>;
  lock: () => void;
  purgeIdentity: (id: string) => Promise<void>;
  switchIdentity: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  rescan: (height: number) => Promise<void>;
  churn: () => Promise<string>;
  createSubaddress: (label?: string) => Promise<string | undefined>;
  renameIdentity: (id: string, name: string) => Promise<void>;
  setSubaddressLabel: (index: number, label: string) => Promise<void>;
}

const VaultContext = createContext<VaultContextType | undefined>(undefined);

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [balance, setBalance] = useState({ total: '0.0000', unlocked: '0.0000' });
  const [address, setAddress] = useState('');
  const [subaddresses, setSubaddresses] = useState<SubaddressInfo[]>([]);
  const [outputs, setOutputs] = useState<OutputInfo[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [currentHeight, setCurrentHeight] = useState<number>(0);
  const [totalHeight, setTotalHeight] = useState<number>(0);
  const [status, setStatus] = useState<string>('READY');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [syncPercent, setSyncPercent] = useState(0);
  const [isAppLoading, setIsAppLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isLocked, setIsLocked] = useState(true);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [activeId, setActiveId] = useState<string>('primary');
  const [hasVaultFile, setHasVaultFile] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStagenet, setIsStagenet] = useState(false);

  const engineRef = useRef<XmrStealthEngine | null>(null);

  const addLog = useCallback((msg: string, type: any = 'info') => {
    setLogs(prev => [{ msg, timestamp: Date.now(), type }, ...prev].slice(0, 100));
  }, []);

  const refresh = useCallback(async () => {
    if (!engineRef.current) return;
    try {
      const [b, h, height, networkHeight, subs, outs] = await Promise.all([
        engineRef.current.getBalance(),
        engineRef.current.getTxs(),
        engineRef.current.getHeight(),
        engineRef.current.getNetworkHeight(),
        engineRef.current.getSubaddresses(),
        engineRef.current.getOutputs()
      ]);
      setBalance(b);
      setTxs(h);
      setCurrentHeight(height);
      if (networkHeight > 0) setTotalHeight(networkHeight); // Only update if valid

      // Auto-calc sync percent if not provided by listener
      if (networkHeight > 0 && height > 0) {
        setSyncPercent((height / networkHeight) * 100);
      }

      setSubaddresses(subs);
      setOutputs(outs);
    } catch (e) { }
  }, []);

  // 🔄 High-frequency polling during sync to ensure UI updates
  useEffect(() => {
    if (status === 'SYNCING') {
      const interval = setInterval(refresh, 2500);
      return () => clearInterval(interval);
    }
  }, [status, refresh]);

  const unlock = useCallback(async (password: string, restoreSeed?: string, restoreHeight?: number, newIdentityName?: string) => {
    if (engineRef.current) return;

    // 🛡️ TACTICAL CHECK: Ensure Tor is ready before allowing unlock if enabled
    const useTorConfig = await window.api.getConfig('use_tor');
    const useTor = useTorConfig !== false; // Default to true if undefined
    
    if (useTor) {
      addLog("🛡️ Verifying Tor Circuit Integrity...", "process");

      let attempts = 0;
      const MAX_ATTEMPTS = 40; // ~2 minutes

      while (true) {
        const uplink = await window.api.getUplinkStatus();
        if (uplink.isTorReady) {
          addLog("✅ Tor Circuit Secured.", "success");
          break;
        }

        attempts++;
        if (attempts > MAX_ATTEMPTS) {
          throw new Error("TOR_TIMEOUT: Uplink failed to bootstrap. Check network.");
        }

        if (attempts % 4 === 0) {
          addLog(`⏳ Establishing Tor Uplink... [${attempts}/${MAX_ATTEMPTS}]`, "warning");
        }

        await new Promise(r => setTimeout(r, 3000));
      }
    }

    setIsInitializing(true);
    let targetId = activeId;

    if (newIdentityName) {
      // 🛡️ COLLISION CHECK: Ensure the name (label) is unique
      const nameExists = identities.some(i => i.name.toLowerCase() === newIdentityName.toLowerCase());
      if (nameExists) {
        throw new Error(`CONFLICT: Identity "${newIdentityName}" already exists.`);
      }

      // 🛡️ ID GENERATION: Use random suffix to prevent any chance of file collision
      const randomId = Math.random().toString(36).substring(2, 9);
      const newId = `vault_${Date.now()}_${randomId}`;
      
      const newIdentity = { id: newId, name: newIdentityName, created: Date.now() };
      const updated = [...identities, newIdentity];
      await window.api.saveIdentities(updated);
      await window.api.setActiveIdentity(newId);
      setIdentities(updated);
      setActiveId(newId);
      targetId = newId;
    }

    try {
      const engine = new XmrStealthEngine((msg, type) => addLog(msg, type));
      engineRef.current = engine;

      const seedToUse = restoreSeed || await window.api.getConfig(`master_seed_${targetId}`);
      const [savedHeight, networkSetting] = await Promise.all([
        window.api.getConfig(`last_sync_height_${targetId}`),
        window.api.getConfig('is_stagenet')
      ]);

      const stagenetActive = !!networkSetting;
      setIsStagenet(stagenetActive);

      const listener = new (class extends UpdateListener {
        async onSyncProgress(height: number, startHeight: number, endHeight: number, percentDone: number, message: string) {
          // monero-ts provides percentDone as 0.0 - 1.0
          const displayPercent = Math.min(percentDone * 100, 100);
          
          setCurrentHeight(height);
          if (endHeight > 0) setTotalHeight(endHeight);
          setSyncPercent(displayPercent);

          if (height % 1000 === 0 || percentDone >= 0.99) {
            addLog(`📡 Scanning Ledger: ${displayPercent.toFixed(1)}% [${height}/${endHeight || '?'}]`, 'process');
          }
          
          // Persist height
          if (height > 0) window.api.setConfig(`last_sync_height_${targetId}`, height);
        }
        async onNewBlock(height: number) {
          setCurrentHeight(height);
          if (height > 0) window.api.setConfig(`last_sync_height_${targetId}`, height);
          
          // Refresh total height on new blocks
          engine.getNetworkHeight().then(nh => {
            if (nh > 0) setTotalHeight(nh);
          });
        }
      })(engine);

      const result = await engine.init(
        "http://127.0.0.1:18082", 
        password, 
        seedToUse, 
        0, 
        restoreHeight || savedHeight || undefined, // 🛡️ Use undefined to trigger engine defaults
        listener, 
        stagenetActive, 
        targetId
      );

      // Immediately fetch network height to drive the progress bar
      if (result.networkHeight > 0) {
        setTotalHeight(result.networkHeight);
      }

      const mnemonic = await engine.getMnemonic();
      if (mnemonic) await window.api.setConfig(`master_seed_${targetId}`, mnemonic);

      setAddress(result.address);
      setIsLocked(false);
      setHasVaultFile(true);
      setIsInitializing(false);

      // Start Background Sync
      setStatus('SYNCING');
      engine.startSyncInBackground();

      await refresh();
    } catch (e: any) {
      engineRef.current = null;
      setIsInitializing(false);
      throw e;
    }
  }, [activeId, identities, refresh, addLog]);

  const lock = useCallback(async () => {
    if (engineRef.current) { 
      await engineRef.current.shutdown(); 
      engineRef.current = null; 
    }
    setAddress('');
    setBalance({ total: '0.0000', unlocked: '0.0000' });
    setIsLocked(true);
    setStatus('READY');
  }, []);

  const purgeIdentity = useCallback(async (id: string) => {
    const targetName = identities.find(i => i.id === id)?.name || id;
    if (!confirm(`🚨 DELETE IDENTITY "${targetName}"?`)) return;
    await window.api.setConfig(`master_seed_${id}`, null);
    await window.api.setConfig(`last_sync_height_${id}`, null);
    await window.api.writeWalletFile({ filename: id, data: [] });
    const updated = identities.filter(i => i.id !== id);
    await window.api.saveIdentities(updated);
    if (id === activeId) {
      const nextId = updated.length > 0 ? updated[0].id : 'primary';
      await window.api.setActiveIdentity(nextId);
    }
    location.reload();
  }, [identities, activeId]);

  const rescan = useCallback(async (height: number) => {
    if (!engineRef.current) return;
    setStatus('SYNCING');
    addLog(`🔄 Initiating rescan from height: ${height}...`);
    try {
      await engineRef.current.rescan(height);
      await refresh();
    } catch (e: any) {
      addLog(`❌ RESCAN_ERROR: ${e.message}`);
    } finally {
      setStatus('READY');
    }
  }, [refresh, addLog]);

  useEffect(() => {
    const loadIdentities = async () => {
      try {
        const [ids, current] = await Promise.all([
          window.api.getIdentities(),
          window.api.getActiveIdentity()
        ]);
        
        const validIds = ids || [];
        setIdentities(validIds);
        const nextActiveId = current || (validIds.length > 0 ? validIds[0].id : '');
        setActiveId(nextActiveId);
        
        if (validIds.length > 0 && nextActiveId) {
          const fileData = await window.api.readWalletFile(nextActiveId);
          setHasVaultFile(!!fileData && fileData.length > 0);
        } else {
          setHasVaultFile(false);
        }
        setIsAppLoading(false);
      } catch (err) { } finally {
        setIsAppLoading(false);
      }
    };
    loadIdentities();
  }, []);

  // 🛡️ GRACEFUL SHUTDOWN LISTENER
  useEffect(() => {
    if (window.api.onVaultShutdown) {
      window.api.onVaultShutdown(async () => {
        addLog("🛡️ System shutdown signal received. Securing vault...", "process");
        if (engineRef.current) {
          await engineRef.current.shutdown();
        }
        window.api.confirmShutdown();
      });
    }
  }, [addLog]);

  useEffect(() => {
    if (!isLocked && !isInitializing) {
      const interval = setInterval(refresh, 20000);
      return () => clearInterval(interval);
    }
  }, [isLocked, isInitializing, refresh]);

  const value = {
    balance, address, subaddresses, outputs, status, logs, txs, currentHeight, totalHeight, syncPercent,
    isAppLoading, isInitializing, isLocked, isSending, hasVaultFile, identities, activeId, isStagenet,
    unlock, lock, purgeIdentity, switchIdentity: useCallback(async (id: string) => { await window.api.setActiveIdentity(id); location.reload(); }, []),
    refresh, rescan, churn: useCallback(async () => {
      if (!engineRef.current) throw new Error("NOT_INIT");
      setIsSending(true);
      try { const txHash = await engineRef.current.churn(); await refresh(); return txHash; }
      finally { setIsSending(false); }
    }, [refresh]),
    createSubaddress: useCallback(async (label?: string) => {
      if (!engineRef.current) return;
      try { const newAddr = await engineRef.current.createNextSubaddress(label); await refresh(); return newAddr; } catch (e) { }
    }, [refresh]),
    renameIdentity: useCallback(async (id: string, name: string) => {
      // 🛡️ CHECK: Is the target name already taken by ANOTHER identity?
      const nameExists = identities.some(i => i.id !== id && i.name.toLowerCase() === name.toLowerCase());
      if (nameExists) throw new Error(`CONFLICT: Name "${name}" is already in use.`);

      await window.api.renameIdentity(id, name);
      const ids = await window.api.getIdentities();
      setIdentities(ids);
    }, [identities]),
    setSubaddressLabel: useCallback(async (index: number, label: string) => {
      if (!engineRef.current) return;
      try { await engineRef.current.setSubaddressLabel(index, label); await refresh(); } catch (e) { }
    }, [refresh])
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault() {
  const context = useContext(VaultContext);
  if (!context) throw new Error('useVault must be used within VaultProvider');
  return context;
}
