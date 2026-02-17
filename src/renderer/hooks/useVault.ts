import { useState, useEffect, useCallback, useRef } from 'react';
import { XmrStealthEngine } from '../services/stealth/XmrStealthEngine';
import { StealthStep } from '../services/stealth/types';

export interface Identity {
  id: string;
  name: string;
  created: number;
}

export function useVault() {
  const [balance, setBalance] = useState({ total: '0.0000', unlocked: '0.0000' });
  const [address, setAddress] = useState('');
  const [txs, setTxs] = useState<any[]>([]);
  const [currentHeight, setCurrentHeight] = useState<number>(0);
  const [status, setStatus] = useState<StealthStep>(StealthStep.IDLE);
  const [logs, setLogs] = useState<string[]>([]);
  const [syncPercent, setSyncPercent] = useState(0);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isLocked, setIsLocked] = useState(true);
  
  // Identity Management
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [activeId, setActiveId] = useState<string>('primary');
  const [hasVaultFile, setHasVaultFile] = useState(false);

  const [isSending, setIsSending] = useState(false);
  const [isStagenet, setIsStagenet] = useState(false);
  const engineRef = useRef<XmrStealthEngine | null>(null);

  const addLog = useCallback((msg: string) => {
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

  // 1. Initial Identity Loading
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
        // Ensure fileData is not empty and is a valid buffer/Uint8Array
        setHasVaultFile(!!fileData && fileData.length > 0);
      } catch (err) {
        console.error("Identity Load Failed:", err);
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

  const unlock = useCallback(async (password: string) => {
    if (engineRef.current) return;

    setIsInitializing(true);
    addLog(`🌀 Establishing Uplink: ${activeId}...`);

    try {
      const engine = new XmrStealthEngine((msg) => addLog(msg));
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
          const result = await engine.init(
            rpcUrl, 
            password,
            savedSeed, 
            0, 
            savedHeight || 0,
            (h) => saveSyncHeight(h),
            stagenetActive,
            activeId // Pass ID for file routing
          );
          
          if (!savedSeed) {
            await (window as any).api.setConfig(`master_seed_${activeId}`, engine.getMnemonic());
            addLog("✨ New identity archived securely.");
          }

          setAddress(result.address);
          setIsLocked(false);
          setHasVaultFile(true); // Update state to reflect file exists on disk
          setIsInitializing(false);
          addLog("🔓 Identity active. Uplink established.");

          engine.startSyncInBackground((h) => saveSyncHeight(h));
          success = true;
        } catch (err: any) {
          if (err.message.includes('password') || err.message.includes('decrypt')) {
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
  }, [activeId, addLog, saveSyncHeight]);

  const refresh = useCallback(async () => {
    if (!engineRef.current) return;
    try {
      const [b, h, height] = await Promise.all([
        engineRef.current.getBalance(),
        engineRef.current.getTxs(),
        engineRef.current.getHeight()
      ]);
      setBalance(b);
      setTxs(h);
      setCurrentHeight(height);
    } catch (e) {}
  }, []);

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
    // Switch to new identity
    await (window as any).api.setActiveIdentity(newId.id);
    location.reload(); // Reload to force re-auth
  }, [identities]);

  const switchIdentity = useCallback(async (id: string) => {
    await (window as any).api.setActiveIdentity(id);
    location.reload();
  }, []);

  useEffect(() => {
    if (!isLocked && !isInitializing) {
      const interval = setInterval(refresh, 20000);
      return () => clearInterval(interval);
    }
  }, [isLocked, isInitializing, refresh]);

  return {
    balance, address, status, logs, txs, currentHeight, refresh, rescan,
    isInitializing, isLocked, unlock, hasVaultFile, isSending,
    identities, activeId, createIdentity, switchIdentity,
    createSubaddress: useCallback(async () => {
      if (!engineRef.current) return;
      addLog("👻 Generating fresh subaddress...");
      try {
        const newAddr = await engineRef.current.createNextSubaddress();
        setAddress(newAddr);
        addLog("✨ Subaddress ready.");
        return newAddr;
      } catch (e: any) {
        addLog(`❌ SUBADDR_ERROR: ${e.message}`);
      }
    }, [addLog]),
    syncPercent,
    isStagenet
  };
}
