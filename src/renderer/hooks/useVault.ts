import { useState, useEffect, useCallback, useRef } from 'react';
import { XmrStealthEngine } from '../services/stealth/XmrStealthEngine';
import { StealthStep } from '../services/stealth/types';

export interface Identity { id: string; name: string; created: number; }
export interface SubaddressInfo { index: number; address: string; label: string; balance: string; unlockedBalance: string; isUsed: boolean; }
export interface OutputInfo { amount: string; index: number; keyImage: string; isUnlocked: boolean; isFrozen: boolean; subaddressIndex: number; timestamp: number; }

export function useVault() {
  // --- 1. STATE HOOKS (Strict order) ---
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

  const unlock = useCallback(async (password: string) => {
    if (engineRef.current) return;
    setIsInitializing(true);
    addLog(`🌀 Establishing Uplink: ${activeId}...`);
    try {
      const engine = new XmrStealthEngine((msg, type) => addLog(msg, type));
      engineRef.current = engine;
      const [savedSeed, savedHeight, networkSetting] = await Promise.all([
        (window as any).api.getConfig(`master_seed_${activeId}`),
        (window as any).api.getConfig(`last_sync_height_${activeId}`),
        (window as any).api.getConfig('is_stagenet')
      ]);
      const stagenetActive = !!networkSetting;
      setIsStagenet(stagenetActive);
      const rpcUrl = "http://127.0.0.1:18082";
      let retryCount = 0;
      let success = false;
      while (retryCount < 3 && !success) {
        try {
          const result = await engine.init(rpcUrl, password, savedSeed, 0, savedHeight || 0, (h) => saveSyncHeight(h), stagenetActive, activeId);
          if (!savedSeed) await (window as any).api.setConfig(`master_seed_${activeId}`, engine.getMnemonic());
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
          if (msg.includes('password') || msg.includes('decrypt') || msg.includes('deserialize')) {
             throw new Error("INVALID_SECRET");
          }
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
  }, [activeId, addLog, saveSyncHeight, refresh]);

  const sendXmr = useCallback(async (toAddress: string, amount: number) => {
    if (!engineRef.current) return;
    setIsSending(true);
    addLog(`💸 Initiating outbound transfer: ${amount} XMR...`);
    try {
      const txHash = await engineRef.current.transfer(toAddress, amount);
      addLog(`✅ SUCCESS: ${txHash.substring(0, 16)}...`);
      await refresh();
      return txHash;
    } catch (e: any) {
      addLog(`❌ SEND_ERROR: ${e.message}`);
      throw e;
    } finally {
      setIsSending(false);
    }
  }, [refresh, addLog]);

  const churn = useCallback(async () => {
    if (!engineRef.current) return;
    setIsSending(true);
    try {
      const txHash = await engineRef.current.churn();
      addLog(`🌪️ CHURN_COMPLETE: ${txHash.substring(0, 16)}...`);
      await refresh();
      return txHash;
    } catch (e: any) {
      addLog(`❌ CHURN_ERROR: ${e.message}`);
      throw e;
    } finally {
      setIsSending(false);
    }
  }, [refresh, addLog]);

  const rescan = useCallback(async (height: number) => {
    if (!engineRef.current) return;
    addLog(`🔄 Initiating rescan from height: ${height}...`);
    try {
      await engineRef.current.rescan(height);
      await refresh();
    } catch (e: any) {
      addLog(`❌ RESCAN_ERROR: ${e.message}`);
    }
  }, [addLog, refresh]);

  const createIdentity = useCallback(async (name: string) => {
    const newId = { id: `vault_${Date.now()}`, name, created: Date.now() };
    const updated = [...identities, newId];
    await (window as any).api.saveIdentities(updated);
    setIdentities(updated);
    await (window as any).api.setActiveIdentity(newId.id);
    location.reload();
  }, [identities]);

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
    balance, address, subaddresses, outputs, status, logs, txs, currentHeight, refresh, rescan, churn,
    isInitializing, isLocked, unlock, hasVaultFile, isSending,
    identities, activeId, createIdentity, switchIdentity,
    createSubaddress: useCallback(async (label?: string) => {
      if (!engineRef.current) return;
      addLog(`👻 Generating fresh subaddress: ${label || 'Receive'}...`);
      try {
        const newAddr = await engineRef.current.createNextSubaddress(label);
        setAddress(newAddr);
        addLog("✨ Subaddress ready.");
        await refresh();
        return newAddr;
      } catch (e: any) {
        addLog(`❌ SUBADDR_ERROR: ${e.message}`);
      }
    }, [addLog, refresh]),
    syncPercent,
    isStagenet
  };
}
