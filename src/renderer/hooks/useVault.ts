import { useState, useEffect, useCallback, useRef } from 'react';
import { XmrStealthEngine } from '../services/stealth/XmrStealthEngine';
import { StealthStep } from '../services/stealth/types';

export interface Identity { id: string; name: string; created: number; }
export interface SubaddressInfo { index: number; address: string; label: string; balance: string; unlockedBalance: string; isUsed: boolean; }
export interface OutputInfo { amount: string; index: number; keyImage: string; isUnlocked: boolean; isFrozen: boolean; subaddressIndex: number; timestamp: number; }

export function useVault() {
  // --- 1. STATE HOOKS ---
  const [balance, setBalance] = useState({ total: '0.0000', unlocked: '0.0000' });
  const [address, setAddress] = useState('');
  const [subaddresses, setSubaddresses] = useState<SubaddressInfo[]>([]);
  const [outputs, setOutputs] = useState<OutputInfo[]>([]);
  const [txs, setTxs] = useState<any[]>([]);
  const [currentHeight, setCurrentHeight] = useState<number>(0);
  const [status, setStatus] = useState<StealthStep>(StealthStep.IDLE);
  const [logs, setLogs] = useState<string[]>([]);
  const [syncPercent, setSyncPercent] = useState(0);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLocked, setIsLocked] = useState(true);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [activeId, setActiveId] = useState<string>('primary');
  const [hasVaultFile, setHasVaultFile] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStagenet, setIsStagenet] = useState(false);

  // --- 2. REF HOOKS ---
  const engineRef = useRef<XmrStealthEngine | null>(null);

  // --- 3. CALLBACK HOOKS ---
  const addLog = useCallback((msg: string, type?: 'info' | 'success' | 'warning' | 'process' | 'error') => {
    setLogs(prev => [msg, ...prev].slice(0, 20));
    const match = msg.match(/(\d+(\.\d+)?)\s*%/);
    if (match) {
      const p = parseFloat(match[1]);
      if (!isNaN(p)) setSyncPercent(p);
    }
  }, []);

  const saveSyncHeight = useCallback(async (h: number) => {
    if (h > 0) await (window as any).api.setConfig(`last_sync_height_${activeId}`, h);
  }, [activeId]);

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
      addLog(`✨ New identity registered: ${newIdentityName}`);
    }
    addLog(`🌀 Establishing Uplink: ${targetId}...`);
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
      const rpcUrl = "http://127.0.0.1:18082";
      let retryCount = 0;
      let success = false;
      while (retryCount < 3 && !success) {
        try {
          const result = await engine.init(rpcUrl, password, seedToUse, 0, restoreHeight || savedHeight || 0, (h) => saveSyncHeight(h), stagenetActive, targetId);
          await (window as any).api.setConfig(`master_seed_${targetId}`, engine.getMnemonic());
          setAddress(result.address);
          setIsLocked(false);
          setHasVaultFile(true);
          setIsInitializing(false);
          addLog("🔓 Identity active. Uplink established.");
          engine.startSyncInBackground((h) => saveSyncHeight(h));
          await refresh();
          success = true;
        } catch (err: any) {
          const msg = err.message.toLowerCase();
          if (msg.includes('password') || msg.includes('decrypt') || msg.includes('deserialize')) throw new Error("INVALID_SECRET");
          retryCount++;
          if (retryCount >= 3) throw err;
          addLog(`⚠️ Link unstable. Retrying in 5s... (${retryCount}/3)`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    } catch (e: any) {
      console.error("Vault Init Failed:", e);
      engineRef.current = null;
      setIsInitializing(false);
      throw e;
    }
  }, [activeId, identities, addLog, saveSyncHeight, refresh]);

  const lock = useCallback(async () => {
    if (engineRef.current) {
      engineRef.current.stop();
      engineRef.current = null;
    }
    setAddress('');
    setBalance({ total: '0.0000', unlocked: '0.0000' });
    setSubaddresses([]);
    setOutputs([]);
    setTxs([]);
    setIsLocked(true);
    addLog("🔒 Tactical Lock Engaged. Identity secured.");
  }, [addLog]);

  /**
   * 🚨 Nuclear Purge: Erase everything for a specific identity
   */
  const purgeIdentity = useCallback(async (id: string) => {
    if (!confirm("🚨 WARNING: TOTAL PURGE. This will irreversibly erase the local wallet file AND the cached seed for this identity. Continue?")) return;
    
    // 1. Wipe from electron-store
    await (window as any).api.setConfig(`master_seed_${id}`, null);
    await (window as any).api.setConfig(`last_sync_height_${id}`, null);
    
    // 2. Wipe physical file
    await (window as any).api.writeWalletFile({ filename: id, buffer: [] });
    
    addLog(`☢️ Identity Purged: ${id}`);
    location.reload(); // Hard reset
  }, [addLog]);

  const switchIdentity = useCallback(async (id: string) => {
    await (window as any).api.setActiveIdentity(id);
    location.reload();
  }, []);

  // --- 4. EFFECT HOOKS ---
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
      } catch (err) {
        setHasVaultFile(false);
      } finally {
        setIsInitializing(false);
      }
    };
    loadIdentities();
  }, []);

  useEffect(() => {
    let unsubscribe: any = null;
    if (typeof (window as any).api?.onTorStatus === 'function') {
      unsubscribe = (window as any).api.onTorStatus((msg: string) => {
        addLog(`[TOR] ${msg}`);
      });
    }
    return () => { if (unsubscribe) unsubscribe(); };
  }, [addLog]);

  useEffect(() => {
    if (!isLocked && !isInitializing) {
      const interval = setInterval(refresh, 20000);
      return () => clearInterval(interval);
    }
  }, [isLocked, isInitializing, refresh]);

  return {
    balance, address, subaddresses, outputs, status: status === StealthStep.IDLE ? 'READY' : status, logs, txs, currentHeight, refresh, 
    rescan: useCallback(async (h: number) => {
      if (!engineRef.current) return;
      addLog(`🔄 Initiating rescan from height: ${h}...`);
      try { await engineRef.current.rescan(h); await refresh(); } catch (e: any) { addLog(`❌ RESCAN_ERROR: ${e.message}`); }
    }, [addLog, refresh]), 
    churn: useCallback(async () => {
      if (!engineRef.current) return;
      setIsSending(true);
      try { const txHash = await engineRef.current.churn(); addLog(`🌪️ CHURN_COMPLETE: ${txHash.substring(0, 16)}...`); await refresh(); return txHash; } 
      catch (e: any) { addLog(`❌ CHURN_ERROR: ${e.message}`); throw e; } finally { setIsSending(false); }
    }, [refresh, addLog]),
    isInitializing, isLocked, unlock, lock, purgeIdentity, hasVaultFile, isSending,
    identities, activeId, createIdentity: useCallback(async (name: string) => {}, []), switchIdentity,
    createSubaddress: useCallback(async (label?: string) => {
      if (!engineRef.current) return;
      addLog(`👻 Generating fresh subaddress: ${label || 'Receive'}...`);
      try { const newAddr = await engineRef.current.createNextSubaddress(label); setAddress(newAddr); addLog("✨ Subaddress ready."); await refresh(); return newAddr; } 
      catch (e: any) { addLog(`❌ SUBADDR_ERROR: ${e.message}`); }
    }, [addLog, refresh]),
    syncPercent,
    isStagenet
  };
}
