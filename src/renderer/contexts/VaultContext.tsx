import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { XmrStealthEngine } from '../services/stealth/XmrStealthEngine';
import { StealthStep } from '../services/stealth/types';
import moneroTs from 'monero-ts';

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
      const [b, h, height, subs, outs] = await Promise.all([
        engineRef.current.getBalance(),
        engineRef.current.getTxs(),
        engineRef.current.getHeight(),
        engineRef.current.getSubaddresses(),
        engineRef.current.getOutputs()
      ]);
      setBalance(b);
      setTxs(h);
      setCurrentHeight(height);
      setSubaddresses(subs);
      setOutputs(outs);
    } catch (e) {}
  }, []);

  const unlock = useCallback(async (password: string, restoreSeed?: string, restoreHeight?: number, newIdentityName?: string) => {
    if (engineRef.current) return;

    // 🛡️ TACTICAL CHECK: Ensure Tor is ready before allowing unlock if enabled
    const useTor = await (window as any).api.getConfig('use_tor');
    if (useTor) {
      const uplink = await (window as any).api.getUplinkStatus();
      if (!uplink.isTorReady) {
        throw new Error("TOR_NOT_READY: Wait for bootstrap 100% or disable Tor.");
      }
    }

    setIsInitializing(true);
    let targetId = activeId;

    if (newIdentityName) {
      const newId = `vault_${Date.now()}`;
      const newIdentity = { id: newId, name: newIdentityName, created: Date.now() };
      const updated = [...identities, newIdentity];
      await (window as any).api.saveIdentities(updated);
      await (window as any).api.setActiveIdentity(newId);
      setIdentities(updated);
      setActiveId(newId);
      targetId = newId;
    }

    try {
      const engine = new XmrStealthEngine((msg, type) => addLog(msg, type));
      engineRef.current = engine;

      const seedToUse = restoreSeed || await (window as any).api.getConfig(`master_seed_${targetId}`);
      const [savedHeight, networkSetting] = await Promise.all([
        (window as any).api.getConfig(`last_sync_height_${targetId}`),
        (window as any).api.getConfig('is_stagenet')
      ]);
      
      const stagenetActive = !!networkSetting;
      setIsStagenet(stagenetActive);

      const result = await engine.init("http://127.0.0.1:18082", password, seedToUse, 0, restoreHeight || savedHeight || 0, undefined, stagenetActive, targetId);
      
      const tH = await engine.getNetworkHeight();
      setTotalHeight(tH);

      const mnemonic = await engine.getMnemonic();
      if (mnemonic) await (window as any).api.setConfig(`master_seed_${targetId}`, mnemonic);
      
      setAddress(result.address);
      setIsLocked(false);
      setHasVaultFile(true);
      setIsInitializing(false);
      
      // Start Background Sync
      setStatus('SYNCING');
      engine.startSyncInBackground((h) => {
         if (h > 0) {
           setCurrentHeight(h);
           // Calculate dynamic percentage
           if (tH > 0) {
             const progress = (h / tH) * 100;
             setSyncPercent(progress);
           }
           (window as any).api.setConfig(`last_sync_height_${targetId}`, h);
           if (h % 1000 === 0) addLog(`🛰️ Blockchain Pulse: Block ${h} reached.`);
         }
      });
      
      await refresh();
    } catch (e: any) {
      engineRef.current = null;
      setIsInitializing(false);
      throw e;
    }
  }, [activeId, identities, refresh, addLog]);

  const lock = useCallback(() => {
    if (engineRef.current) { engineRef.current.stop(); engineRef.current = null; }
    setAddress('');
    setBalance({ total: '0.0000', unlocked: '0.0000' });
    setIsLocked(true);
    setStatus('READY');
  }, []);

  const purgeIdentity = useCallback(async (id: string) => {
    const targetName = identities.find(i => i.id === id)?.name || id;
    if (!confirm(`🚨 DELETE IDENTITY "${targetName}"?`)) return;
    await (window as any).api.setConfig(`master_seed_${id}`, null);
    await (window as any).api.setConfig(`last_sync_height_${id}`, null);
    await (window as any).api.writeWalletFile({ filename: id, data: "" });
    const updated = identities.filter(i => i.id !== id);
    await (window as any).api.saveIdentities(updated);
    if (id === activeId) {
       const nextId = updated.length > 0 ? updated[0].id : 'primary';
       await (window as any).api.setActiveIdentity(nextId);
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
          (window as any).api.getIdentities(),
          (window as any).api.getActiveIdentity()
        ]);
        setIdentities(ids || []);
        setActiveId(current || 'primary');
        const fileData = await (window as any).api.readWalletFile(current || 'primary');
        setHasVaultFile(!!fileData && fileData.length > 0);
      } catch (err) {} finally { 
        setIsAppLoading(false);
      }
    };
    loadIdentities();
  }, []);

  useEffect(() => {
    if (!isLocked && !isInitializing) {
      const interval = setInterval(refresh, 20000);
      return () => clearInterval(interval);
    }
  }, [isLocked, isInitializing, refresh]);

  const value = {
    balance, address, subaddresses, outputs, status, logs, txs, currentHeight, totalHeight, syncPercent,
    isAppLoading, isInitializing, isLocked, isSending, hasVaultFile, identities, activeId, isStagenet,
    unlock, lock, purgeIdentity, switchIdentity: useCallback(async (id: string) => { await (window as any).api.setActiveIdentity(id); location.reload(); }, []),
    refresh, rescan, churn: useCallback(async () => {
      if (!engineRef.current) throw new Error("NOT_INIT");
      setIsSending(true);
      try { const txHash = await engineRef.current.churn(); await refresh(); return txHash; } 
      finally { setIsSending(false); }
    }, [refresh]),
    createSubaddress: useCallback(async (label?: string) => {
      if (!engineRef.current) return;
      try { const newAddr = await engineRef.current.createNextSubaddress(label); await refresh(); return newAddr; } catch (e) {}
    }, [refresh]),
    renameIdentity: useCallback(async (id: string, name: string) => {
      await (window as any).api.renameIdentity(id, name);
      const ids = await (window as any).api.getIdentities();
      setIdentities(ids);
    }, []),
    setSubaddressLabel: useCallback(async (index: number, label: string) => {
      if (!engineRef.current) return;
      try { await engineRef.current.setSubaddressLabel(index, label); await refresh(); } catch (e) {}
    }, [refresh])
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault() {
  const context = useContext(VaultContext);
  if (!context) throw new Error('useVault must be used within VaultProvider');
  return context;
}
