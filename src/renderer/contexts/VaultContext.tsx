import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { WalletService, Transaction } from '../services/walletService';

export interface Identity { id: string; name: string; created: number; }
export interface SubaddressInfo { index: number; address: string; label: string; balance: string; unlockedBalance: string; isUsed: boolean; }
export interface LogEntry { msg: string; timestamp: number; type?: 'info' | 'success' | 'warning' | 'process' | 'error'; }
export type MoneroAccount = {
  "index": number
  "label": string,
  "balance": string,
  "unlockedBalance": string,
  "baseAddress": string
}

export interface VaultContextType {
  accounts: MoneroAccount[];
  selectedAccountIndex: number;
  balance: { total: string; unlocked: string };
  address: string;
  subaddresses: SubaddressInfo[];
  status: string;
  logs: LogEntry[];
  txs: Transaction[];
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
  outputs: any[];
  setSelectedAccountIndex: (index: number) => void;
  createAccount: (label: string) => Promise<void>;
  unlock: (password: string, newIdentityName?: string, restoreSeed?: string, restoreHeight?: number, seedLanguage?: string) => Promise<void>;
  lock: () => void;
  sendXmr: (address: string, amount: number) => Promise<string | undefined>;
  sendMulti: (destinations: { address: string; amount: number }[], subaddrIndices?: number[]) => Promise<void>;
  purgeIdentity: (id: string) => Promise<void>;
  switchIdentity: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  createSubaddress: (label?: string) => Promise<string | undefined>;
  renameIdentity: (id: string, name: string) => Promise<void>;
  renameAccount: (accountIndex: number, newLabel: string) => Promise<void>;
  churn: () => Promise<void>;
  splinter: (fragments: number) => Promise<void>;
  vanishCoin: (keyImage: string) => Promise<void>;
  vanishSubaddress: (subaddressIndex: number) => Promise<void>;
  setSubaddressLabel: (index: number, label: string) => Promise<void>;
  rescan: (height: number) => Promise<void>;
}

const VaultContext = createContext<VaultContextType | undefined>(undefined);

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [selectedAccountIndex, setSelectedAccountIndex] = useState(0);
  const [accounts, setAccounts] = useState<MoneroAccount[]>([]);
  const [balance, setBalance] = useState({ total: '0.0000', unlocked: '0.0000' });
  const [address, setAddress] = useState('');
  const [subaddresses, setSubaddresses] = useState<SubaddressInfo[]>([]);
  const [txs, setTxs] = useState<Transaction[]>([]);
  const [currentHeight, setCurrentHeight] = useState<number>(0);
  const [totalHeight, setTotalHeight] = useState<number>(0);
  const [status, setStatus] = useState<string>('READY');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [syncPercent, setSyncPercent] = useState(0);
  const [isAppLoading, setIsAppLoading] = useState(true);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isLocked, setIsLocked] = useState(true);
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [activeId, setActiveId] = useState<string>("primary");
  const [hasVaultFile, setHasVaultFile] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isStagenet, setIsStagenet] = useState(false);
  const [outputs, setOutputs] = useState<any[]>([]);
  const lastHeightRef = useRef<number>(0); // Track previous height for sync detection

  const addLog = useCallback((msg: string, type: any = 'info') => {
    setLogs(prev => [{ msg, timestamp: Date.now(), type }, ...prev].slice(0, 100));
  }, []);

  const refresh = useCallback(async () => {
    if (isLocked || isInitializing) return;

    try {
      const allAccs = await WalletService.getAccounts().catch(() => null);
      if (allAccs) setAccounts(allAccs);

      // Use allSettled: a single RPC failure (e.g. get_transfers over flaky Tor)
      // must NOT prevent balance/height/addresses from displaying
      const results = await Promise.allSettled([
        WalletService.getBalance(selectedAccountIndex),
        WalletService.getHeight(selectedAccountIndex),
        WalletService.getTransactions(selectedAccountIndex),
        WalletService.getSubaddresses(selectedAccountIndex),
        WalletService.getOutputs(selectedAccountIndex)
      ]);

      const [balRes, heightRes, txsRes, addrRes, outsRes] = results;

      if (balRes.status === 'fulfilled') setBalance(balRes.value);
      if (heightRes.status === 'fulfilled') setCurrentHeight(heightRes.value);
      if (txsRes.status === 'fulfilled') setTxs(txsRes.value);
      if (addrRes.status === 'fulfilled') {
        setSubaddresses(addrRes.value);
        setAddress(addrRes.value[0]?.address || '');
      }
      if (outsRes.status === 'fulfilled') setOutputs(outsRes.value);

    } catch (e: any) {
      console.warn("Sync gap detected:", e.message);
    }
  }, [isLocked, isInitializing, selectedAccountIndex]);

  useEffect(() => {
    console.log("🔌 Initializing Core Log Listener...");
    if (window.api.onCoreLog) {
      const cleanup = window.api.onCoreLog((data) => {
        // Backend data usually looks like { source: 'TOR', level: 'info', message: '...' }
        const typeMap: Record<string, string> = {
          'info': 'info',
          'error': 'error',
          'warn': 'warning',
          'success': 'success'
        };

        const displayMsg = `[${data.source}] ${data.message}`;
        addLog(displayMsg, typeMap[data.level] || 'info');

        if (data.level === 'error') {
          console.error("CORE_FATAL:", data.message);
        }
      });

      return () => cleanup(); // Auto-cleanup listener on unmount to prevent leaks
    }
  }, [addLog]);

  // 🔄 Wallet Event Listener (Real-time updates from SyncWatcher)
  useEffect(() => {
    if (window.api.onWalletEvent) {
      const cleanup = window.api.onWalletEvent((event) => {
        if (event.type === 'SYNC_UPDATE' && event.payload?.height) {
          const newHeight = event.payload.height;
          const daemonH = event.payload.daemonHeight || 0;
          setCurrentHeight(newHeight);

          // Store daemon height for UI display
          if (daemonH > 0) {
            setTotalHeight(daemonH);
            // Use daemon height for accurate sync detection
            const blocksLeft = daemonH - newHeight;
            if (blocksLeft > 5) {
              setStatus('SYNCING');
              setSyncPercent(Math.min((newHeight / daemonH) * 100, 99.9));
            } else {
              setStatus('SYNCED');
              setSyncPercent(100);
            }
          } else {
            // Fallback: height-delta detection when daemon height is unknown
            const prevHeight = lastHeightRef.current;
            if (prevHeight > 0) {
              const delta = newHeight - prevHeight;
              setStatus(delta > 2 ? 'SYNCING' : 'SYNCED');
            }
          }
          lastHeightRef.current = newHeight;
        }
        if (event.type === 'BALANCE_CHANGED' && event.payload?.balance !== undefined) {
          // Set balance directly from SyncWatcher data (piconeros → XMR)
          // This bypasses the renderer's proxy-request pipeline which may be failing
          const formatPico = (v: number) => {
            const whole = Math.floor(v / 1e12);
            const frac = v % 1e12;
            return `${whole}.${frac.toString().padStart(12, '0')}`;
          };
          setBalance({
            total: formatPico(event.payload.balance),
            unlocked: formatPico(event.payload.unlocked || 0)
          });
          // Also trigger refresh for accounts/subaddresses/txs (best effort)
          refresh();
        }
      });
      return () => cleanup();
    }
  }, [refresh]);

  // 🔄 UI Polling Loop (Replaces the background worker)
  useEffect(() => {
    if (!isLocked && !isInitializing) {
      refresh(); // Initial fetch
      const interval = setInterval(refresh, status === 'SYNCING' ? 3000 : 10000);
      return () => clearInterval(interval);
    }
  }, [isLocked, isInitializing, status, refresh]);

  const unlock = useCallback(async (
    password: string,
    newIdentityName?: string,
    restoreSeed?: string,
    restoreHeight?: number,
    seedLanguage?: string
  ) => {
    setIsInitializing(true);
    addLog("🛡️ Waiting for darknet uplink to stabilize...", "process");
    try {
      // 🔄 1. Await background network readiness (Tor + Proxy + Node Discovery)

      // Initial check: if engine is paralyzed, attempt forced restart
      let uplink = await window.api.getUplinkStatus();
      if (uplink.status === 'ERROR') {
        addLog("🔄 Engine is currently paralyzed. Attempting reboot...", "warning");
        await window.api.retryEngine();
        await new Promise(r => setTimeout(r, 3000)); // Give engine some buffer time to change state
      }

      for (let i = 0; i < 20; i++) {
        uplink = await window.api.getUplinkStatus();
        if (uplink.status === 'ONLINE') break;
        if (uplink.status === 'ERROR') throw new Error(uplink.error || "Engine failed to start.");

        addLog(`⏳ Uplink bootstrapping... (Attempt ${i + 1}/20)`, "warning");
        await new Promise(r => setTimeout(r, 3000));
      }

      if (!uplink || uplink.status !== 'ONLINE') {
        throw new Error("UPLINK_TIMEOUT: Could not establish secure route.");
      }

      // Determine ID for the current operation
      let targetId = activeId;
      if (!newIdentityName && !targetId) {
        targetId = await window.api.getActiveIdentity();
      }

      setIsStagenet(uplink.isStagenet);

      // 🛡️ 2. Identity management and RPC interaction
      if (newIdentityName) {
        // --- [CREATE OR RESTORE MODE] ---
        const randomId = Math.random().toString(36).substring(2, 9);
        const newId = `vault_${Date.now()}_${randomId}`;

        // Display different logs based on presence of seed
        if (restoreSeed) {
          addLog(`🌅 Restoring identity from seed: ${newIdentityName}...`, 'process');
        } else {
          addLog(`🆕 Constructing fresh identity: ${newIdentityName}...`, 'process');
        }

        // 🚀 Dispatch to backend: include seed and height parameters
        const res = await window.api.walletAction('create', {
          name: newId,
          pwd: password,
          seed: restoreSeed,
          height: restoreHeight,
          language: seedLanguage
        });

        if (!res.success) throw new Error(res.error);

        // Sync local metadata
        const newIdentity = { id: newId, name: newIdentityName, created: Date.now() };
        const updated = [...identities, newIdentity];

        await window.api.saveIdentities(updated);
        await window.api.setActiveIdentity(newId);

        setIdentities(updated);
        setActiveId(newId);
        targetId = newId;
      } else {
        // --- [OPEN EXISTING WALLET MODE] ---
        if (!targetId || targetId === 'primary') {
          throw new Error("Please create a new identity first.");
        }

        addLog(`🌅 Opening vault: ${targetId}...`, 'process');
        const res = await window.api.walletAction('open', { name: targetId, pwd: password });
        if (!res.success) throw new Error(res.error);
      }

      // Finalize after success
      setHasVaultFile(true);
      setStatus('SYNCING'); // Show SYNCING until first successful refresh confirms otherwise
      setIsLocked(false);
      setIsInitializing(false);
      addLog("✅ Vault unlocked. Synchronizing with network...", "success");

    } catch (e: any) {
      addLog(`❌ FATAL: ${e.message}`, 'error');
      setIsInitializing(false);
      setIsLocked(true);
      throw e;
    }
  }, [activeId, identities, addLog]);

  const lock = useCallback(async () => {
    // 1. 🟢 Immediate UI update (instant lock manifestation)
    setIsLocked(true);
    addLog("🔒 Vault Secured. Finalizing background sync...", 'warning');

    // 2. 🧹 Purge sensitive state
    setAddress('');
    setBalance({ total: '0.0000', unlocked: '0.0000' });
    setStatus('READY');

    // 3. ⏳ Background shutdown (async, non-blocking)
    // No await, processed in an independent async block
    window.api.walletAction('close', {})
      .then(() => {
        addLog("✅ Backend wallet file saved and closed.", 'success');
      })
      .catch((err) => {
        console.error("Lock sequence background error:", err);
        addLog("⚠️ Backend close error (already closed or busy).", 'error');
      });

  }, [addLog]);

  const sendXmr = useCallback(async (destination: string, amount: number, accountIndex?: number) => {
    setIsSending(true);
    addLog(`💸 Preparing transfer of ${amount} XMR...`, 'process');
    try {
      const txHash = await WalletService.sendTransaction(destination, amount, accountIndex || 0);
      addLog(`✅ Transaction dispatched: ${txHash}`, 'success');
      await refresh();
      return txHash;
    } catch (e: any) {
      addLog(`❌ SEND_ERROR: ${e.message}`, 'error');
    } finally {
      setIsSending(false);
    }
  }, [refresh, addLog]);

  const createSubaddress = useCallback(async (label?: string, accountIndex?: number) => {
    try {
      const address = await WalletService.createSubaddress(label || '', accountIndex || 0);
      await refresh();
      return address;
    } catch (e) { console.error(e); }
  }, [refresh]);

  const purgeIdentity = useCallback(async (id: string) => {
    try {
      // Always attempt to close the wallet via RPC first — the wallet-rpc process
      // holds a file lock on .keys files, preventing deletion
      await window.api.walletAction('close', {}).catch(() => { });

      // Physically delete .keys and cache files from disk
      const res = await window.api.deleteIdentityFiles(id);
      if (!res.success) {
        throw new Error(res.error || 'Failed to delete wallet files');
      }

      // Refresh identity list and reload
      const updated = identities.filter(i => i.id !== id);
      setIdentities(updated);
      location.reload();
    } catch (e: any) {
      addLog(`❌ PURGE_FAILED: ${e.message}`, 'error');
      alert(`PURGE_FAILED: ${e.message}`);
    }
  }, [identities, addLog]);

  const renameIdentity = useCallback(async (id: string, name: string) => {
    const nameExists = identities.some(i => i.id !== id && i.name.toLowerCase() === name.toLowerCase());
    if (nameExists) throw new Error(`CONFLICT: Name "${name}" is already in use.`);
    await window.api.renameIdentity(id, name);
    const ids = await window.api.getIdentities();
    setIdentities(ids);
  }, [identities]);

  const createAccount = useCallback(async (label: string) => {
    try {
      addLog(`Generating new account: ${label}...`, 'info');
      const newAcc = await WalletService.createAccount(label);

      setSelectedAccountIndex(newAcc.index);

      await refresh();

      addLog(`Account #${newAcc.index} initialized.`, 'success');
    } catch (e: any) {
      addLog(`Account generation failed: ${e.message}`, 'error');
    }
  }, [refresh, addLog]);

  // Boot Sequence
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
        setHasVaultFile(validIds.length > 0 && !!nextActiveId);
      } catch (err) { } finally {
        setIsAppLoading(false);
      }
    };
    loadIdentities();
  }, []);

  // Graceful Shutdown
  useEffect(() => {
    if (window.api.onVaultShutdown) {
      window.api.onVaultShutdown(async () => {
        addLog("🛡️ System shutdown signal received. Securing vault...", "process");
        await window.api.walletAction('close', {});
        window.api.confirmShutdown();
      });
    }
  }, [addLog]);

  const value = {
    accounts, selectedAccountIndex,
    balance, address, subaddresses, status, logs, txs, currentHeight, totalHeight, syncPercent,
    isAppLoading, isInitializing, isLocked, isSending, hasVaultFile, identities, activeId, isStagenet,
    unlock, lock, purgeIdentity, sendXmr, refresh, createSubaddress, renameIdentity, outputs, setSelectedAccountIndex,
    rescan: async (height: number) => {
      await WalletService.rescan(height);
      await refresh();
    },
    renameAccount: async (accountIndex: number, newLabel: string) => {
      await WalletService.renameAccount(accountIndex, newLabel);
      await refresh();
    },
    churn: async (accountIndex?: number) => {
      await WalletService.churn(accountIndex || selectedAccountIndex);
      refresh();
    },
    splinter: async (fragments: number) => {
      await WalletService.splinter(selectedAccountIndex, fragments);
      refresh();
    },
    vanishCoin: async (keyImage: string) => {
      // 1. Trigger the single UTXO sweep
      const txHash = await WalletService.vanishCoin(keyImage, selectedAccountIndex);
      if (txHash) {
        // 2. Add a success log
        addLog(`✅ Single UTXO vanished! TXID: ${txHash}`, 'success');
      }
    // 3. Refresh the wallet state to update outputs table and balance
      await refresh();
    },
    vanishSubaddress: async (subaddressIndex: number) => {
      const result = await WalletService.vanishSubaddress(subaddressIndex, selectedAccountIndex);
      if (result.txHash) {
        addLog(`✅ Subaddress #${subaddressIndex} vanished → new address. TXID: ${result.txHash}`, 'success');
      }
      await refresh();
    },
    setSubaddressLabel: async (index: number, label: string, accountIndex?: number) => {
      await WalletService.setSubaddressLabel(index, label, accountIndex || selectedAccountIndex);
      await refresh();
    },
    switchIdentity: useCallback(async (id: string) => { await window.api.setActiveIdentity(id); location.reload(); }, []),
    createAccount,
    sendMulti: async (destinations: { address: string; amount: number }[], subaddrIndices?: number[]) => {
      await WalletService.sendMulti(destinations, selectedAccountIndex, subaddrIndices);
      addLog(`✅ Multi-send dispatched: ${destinations.length} recipient(s)`, 'success');
      await refresh();
    }
  };

  return <VaultContext.Provider value={value}>{children}</VaultContext.Provider>;
}

export function useVault() {
  const context = useContext(VaultContext);
  if (!context) throw new Error('useVault must be used within VaultProvider');
  return context;
}