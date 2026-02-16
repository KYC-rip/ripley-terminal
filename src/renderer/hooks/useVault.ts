import { useState, useEffect, useCallback, useRef } from 'react';
import { XmrStealthEngine } from '../services/stealth/XmrStealthEngine';
import { StealthStep } from '../services/stealth/types';

export function useVault() {
  const [balance, setBalance] = useState({ total: '0.0000', unlocked: '0.0000' });
  const [address, setAddress] = useState('');
  const [txs, setTxs] = useState<any[]>([]);
  const [currentHeight, setCurrentHeight] = useState<number>(0);
  const [status, setStatus] = useState<StealthStep>(StealthStep.IDLE);
  const [logs, setLogs] = useState<string[]>([]);
  const [syncPercent, setSyncPercent] = useState(0);
  const [isInitializing, setIsInitializing] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [isStagenet, setIsStagenet] = useState(false);
  const engineRef = useRef<XmrStealthEngine | null>(null);

  const addLog = useCallback((msg: string) => {
    setLogs(prev => [msg, ...prev].slice(0, 20));
    // Support "Syncing: 45.2%" or "Bootstrapped 10%"
    const match = msg.match(/(\d+(\.\d+)?)\s*%/);
    if (match) {
      const p = parseFloat(match[1]);
      if (!isNaN(p)) setSyncPercent(p);
    }
  }, []);

  const saveSyncHeight = useCallback(async (h: number) => {
    if (h > 0) await (window as any).api.setConfig('last_sync_height', h);
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

  const init = useCallback(async () => {
    if (engineRef.current) return;

    setIsInitializing(true);
    addLog("🌀 Booting secure environment...");

    try {
      const engine = new XmrStealthEngine((msg) => addLog(msg));
      engineRef.current = engine;

      const [savedSeed, savedHeight, networkSetting] = await Promise.all([
        (window as any).api.getSeed(),
        (window as any).api.getConfig('last_sync_height'),
        (window as any).api.getConfig('is_stagenet')
      ]);
      
      const stagenetActive = !!networkSetting;
      setIsStagenet(stagenetActive);

      // Point to local tactical proxy gate
      const rpcUrl = "http://127.0.0.1:18081";
      
      let retryCount = 0;
      let success = false;
      while (retryCount < 3 && !success) {
        try {
          const result = await engine.init(
            rpcUrl, 
            savedSeed, 
            0, 
            savedHeight || 0,
            (h) => saveSyncHeight(h),
            stagenetActive
          );
          
          if (!savedSeed) {
            await (window as any).api.saveSeed(engine.getMnemonic());
            addLog("✨ New identity archived securely.");
          }

          setAddress(result.address);
          setStatus(StealthStep.AWAITING_FUNDS);
          const b = await engine.getBalance();
          setBalance(b);
          setSyncPercent(100); // Force completion
          success = true;
        } catch (err: any) {
          retryCount++;
          if (retryCount >= 3) throw err;
          addLog(`⚠️ Link unstable. Retrying in 5s... (${retryCount}/3)`);
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    } catch (e: any) {
      console.error("Vault Init Failed:", e);
      let errMsg = e.message || 'Unknown error';
      if (errMsg.includes('502')) errMsg = "GATEWAY_FAILURE: Check Tor status.";
      addLog(`❌ INIT_ERROR: ${errMsg}`);
      setStatus(StealthStep.ERROR);
    } finally {
      setIsInitializing(false);
    }
  }, [addLog, saveSyncHeight]);

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

  useEffect(() => {
    init();
    const interval = setInterval(refresh, 20000);
    return () => clearInterval(interval);
  }, [init, refresh]);

  return {
    balance,
    address,
    status,
    logs,
    txs,
    currentHeight,
    refresh,
    isInitializing,
    isSending,
    sendXmr,
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
