import React, { useState, useEffect, useRef } from 'react';
import { Skull, RefreshCw, Key, Send, Download, Wind, Loader2, Edit2, Dices, Scissors } from 'lucide-react';
import { Card } from './Card';
import { AddressBook } from './vault/AddressBook';
import { AddressList } from './vault/AddressList';
import { CoinControl } from './vault/CoinControl';
import { TransactionLedger } from './vault/TransactionLedger';
import { VaultModals } from './vault/VaultModals';
import { type VaultContextType } from '../contexts/VaultContext';
import { AddressDisplay } from './common/AddressDisplay';
import { WalletService } from '../services/walletService';
import { useFiatValue } from '../hooks/useFiatValue';

interface VaultViewProps {
  setView: (v: any) => void;
  vault: VaultContextType;
  handleBurn: () => void;
}

export function VaultView({ setView, vault, handleBurn }: VaultViewProps) {
  const {
    accounts, selectedAccountIndex, setSelectedAccountIndex,
    balance, address, subaddresses, outputs, refresh,
    status, isSending, sendXmr, createSubaddress,
    churn, splinter, txs, currentHeight, totalHeight, syncPercent, activeId, setSubaddressLabel,
    vanishSubaddress
  } = vault;
  const [tab, setTab] = useState<'ledger' | 'addresses' | 'coins' | 'contacts'>('ledger');
  const [modals, setModals] = useState({ seed: false, receive: false, send: false });
  const [mnemonic, setMnemonic] = useState('');
  const [isChurning, setIsChurning] = useState(false);
  const [isSplintering, setIsSplintering] = useState(false);
  const [contacts, setContacts] = useState<any[]>([]);
  const [dispatchAddr, setDispatchAddr] = useState('');
  const [selectedSubaddress, setSelectedSubaddress] = useState<any>(null);
  const [dispatchSubIndex, setDispatchSubIndex] = useState<number | undefined>(undefined);
  const [showAccountDropdown, setShowAccountDropdown] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [editAccountName, setEditAccountName] = useState('');

  const currentAcc = accounts.find(a => a.index === selectedAccountIndex);
  const currentAccBalance = currentAcc?.balance || '0.0000';
  const { fiatText: usdValue } = useFiatValue('XMR', currentAccBalance, true);

  // 1. Load contacts (modified getConfig logic)
  useEffect(() => {
    const loadAddressBook = async () => {
      const config = await window.api.getConfig();
      // Assume address book is stored under a specific key in the config object
      const bookKey = `address_book_${activeId}` as keyof typeof config;
      setContacts((config as any)[bookKey] || []);
    };
    loadAddressBook();
  }, [activeId]);

  // Click-away listener to close the dropdown
  const dropdownRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowAccountDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const saveContacts = async (updated: any[]) => {
    setContacts(updated);
    const currentConfig = await window.api.getConfig();
    await window.api.saveConfigAndReload({
      ...currentConfig,
      [`address_book_${activeId}`]: updated
    });
  };

  const handleChurn = async () => {
    if (!confirm("INITIATE_CHURN? This will break on-chain linkability by sweeping all outputs to yourself.")) return;
    setIsChurning(true);
    try {
      await churn();
    }
    catch (e: any) { alert(`CHURN_FAILED: ${e.message}`); }
    finally { setIsChurning(false); }
  };

  const handleSplinter = async () => {
    const raw = prompt("SPLINTER_BALANCE: Enter number of fragments to shatter your balance into (2-10).", "5");
    if (!raw) return;
    const n = parseInt(raw, 10);
    if (isNaN(n) || n < 2 || n > 10) {
      alert("INVALID_INPUT: Fragments must be a number between 2 and 10.");
      return;
    }
    if (!confirm(`CONFIRM_SPLINTER: Shatter current unlocked balance into ${n} new UTXOs?`)) return;

    setIsSplintering(true);
    try {
      await splinter(n);
    } catch (e: any) {
      alert(`SPLINTER_FAILED: ${e.message}`);
    } finally {
      setIsSplintering(false);
    }
  };

  const handleOpenCreateModal = async () => {
    const label = prompt("ENTER_ACCOUNT_LABEL:", "Savings_Account");

    if (label) {
      try {
        const res = await WalletService.createAccount(label);

        if (res.address) {
          await refresh();
          setSelectedAccountIndex(res.index);
        }
      } catch (e: any) {
        alert(`ACCOUNT_CREATION_FAILED: ${e.message}`);
      }
    }
  };

  // 2. View mnemonic seed (safely retrieved via backend)
  const revealSeed = async () => {
    if (!confirm("⚠️ SECURITY WARNING ⚠️\n\nReveal Master Seed?\nEnsure no cameras or screen recording software is active.")) return;

    try {
      const res = await window.api.walletAction('mnemonic');
      if (res.success && res.seed) {
        setMnemonic(res.seed);
        setModals(prev => ({ ...prev, seed: true }));
      } else {
        alert(`SEED_RETRIEVAL_FAILED: ${res.error || 'Wallet may still be syncing. Try again in a moment.'}`);
      }
    } catch (e: any) {
      alert(`RPC_ERROR: ${e.message || 'Could not retrieve mnemonic. Wallet may be busy syncing.'}`);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const isSyncing = status === 'SYNCING' || status === 'READY';
  const isFullySynced = status === 'SYNCED';

  return (
    <div className="max-w-6xl mx-auto space-y-6 py-2 pt-0 animate-in fade-in zoom-in-95 duration-300 font-black relative">

      {/* 1. HEADER */}
      <div className="flex justify-between items-end border-b border-xmr-border/30 pb-4 relative z-10 font-black">
        <div>
          <button onClick={() => setView('home')} className="text-xs text-xmr-dim hover:text-xmr-green mb-1 flex items-center gap-1 cursor-pointer font-black transition-all uppercase tracking-widest">[ DASHBOARD ]</button>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-mono leading-none">Vault_Storage</h2>
        </div>
        <div className="flex gap-2 font-black">
          <button
            onClick={handleSplinter}
            disabled={isSyncing || isSending || parseFloat(currentAcc?.unlockedBalance || '0') <= 0 || isSplintering}
            className="px-3 py-1.5 border border-xmr-accent/50 text-xmr-accent text-[11px] hover:bg-xmr-accent/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black disabled:opacity-50"
            title="Shatter UTXOs / Fragment Balance"
          >
            <Scissors size={10} className={isSplintering ? 'animate-pulse' : ''} /> {isSplintering ? 'Processing...' : 'Splinter'}
          </button>
          <button
            onClick={handleChurn}
            disabled={isSyncing || isSending || parseFloat(currentAcc?.unlockedBalance || '0') <= 0 || isChurning}
            className="px-3 py-1.5 border border-xmr-accent/50 text-xmr-accent text-[11px] hover:bg-xmr-accent/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black disabled:opacity-50"
            title="Consolidate UTXOs / Break Heuristics"
          >
            <Dices size={10} className={isChurning ? 'animate-spin' : ''} /> {isChurning ? 'Sweeping...' : 'Churn_UTXOs'}
          </button>
          <button onClick={handleBurn} className="px-3 py-1.5 border border-red-900/50 text-red-500 text-[11px] hover:bg-red-500/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><Skull size={10} /> Burn_ID</button>
          <button onClick={refresh} className="px-3 py-1.5 border border-xmr-border text-[11px] hover:bg-xmr-green/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black">
            <RefreshCw size={10} className={isSyncing || isSending ? 'animate-spin' : ''} /> Sync_Ledger
          </button>
        </div>
      </div>

      {/* SYNC STATUS BANNER */}
      {isSyncing && (
        <div className="flex items-center gap-3 px-4 py-3 bg-xmr-accent/10 border border-xmr-accent/30 rounded-sm animate-pulse">
          <Loader2 size={14} className="text-xmr-accent animate-spin shrink-0" />
          <span className="text-xs font-black text-xmr-accent uppercase tracking-widest leading-relaxed">
            Synchronizing_Ledger... Height: {currentHeight || '---'}
            {totalHeight > 0 && currentHeight > 0 ? ` ( ${Math.max(0, totalHeight - currentHeight)} BLOCKS LEFT : ${syncPercent?.toFixed(2)}% )` : ''}
            — Send/Receive disabled until sync completes
          </span>
        </div>
      )}

      {/* 2. TOP GRID (Balances & ID) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative z-10 font-black font-mono">
        <Card topGradientAccentColor="xmr-green" className="lg:col-span-2 flex flex-col justify-between">
          <div className="flex justify-between items-start">
            <div>
              <div className="flex items-center gap-3 mb-1">
                {/* 🚀 CORE: Account Switcher - Elevated to Headline position */}
                <div
                  onClick={() => setShowAccountDropdown(true)}
                  className="flex items-center bg-transparent border border-xmr-border/30 hover:border-xmr-green/50 rounded px-3 py-1.5 gap-3 cursor-pointer transition-all w-fit group"
                >
                  <div className="flex flex-raw space-x-2">
                    <span className="text-sm text-xmr-dim uppercase font-bold tracking-[0.2em] group-hover:text-xmr-green transition-colors">{String(selectedAccountIndex).padStart(2, '0')}</span>
                    <span className='text-sm text-xmr-dim uppercase font-bold tracking-[0.2em] group-hover:text-xmr-green transition-colors'>-</span>
                    <span className="text-sm text-xmr-green font-black uppercase tracking-widest">
                      {currentAcc?.label || 'UNTITLED_IDENTITY'}
                    </span>
                  </div>
                  <span className="text-xs text-xmr-dim font-black opacity-50 group-hover:text-xmr-green transition-colors ml-4">▼</span>
                </div>
              </div>

              <div className="flex flex-col mt-6">
                <div className="text-5xl font-black text-xmr-green leading-none">
                  {currentAccBalance}
                  <span className="text-xl text-xmr-dim uppercase ml-3">XMR</span>
                </div>
                {usdValue && (
                  <div className="text-sm font-black text-xmr-dim uppercase tracking-widest mt-2 px-1">
                    {usdValue} USD
                  </div>
                )}
              </div>
            </div>
            <div
              className="relative group/tooltip"
              title={
                isSyncing ? "Wait for vault to fully sync before churning." :
                  parseFloat(currentAcc?.unlockedBalance || '0') <= 0 ? "You need an unlocked XMR balance to churn." :
                    "Churning sweeps all your unlocked XMR back to yourself. This improves privacy and merges fragmented outputs, but costs a standard network fee."
              }
            >
              <button
                disabled={isSyncing || isChurning || parseFloat(currentAcc?.unlockedBalance || '0') <= 0}
                onClick={handleChurn}
                className={`flex flex-col items-center gap-2 p-4 border border-xmr-green/20 hover:bg-xmr-green/5 transition-all group cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${isChurning ? 'animate-pulse' : ''}`}
              >
                <Wind size={24} className={isChurning ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-700'} />
                <span className="text-xs font-black uppercase tracking-widest">
                  {isChurning ? 'Churning...' : 'Churn_All'}
                </span>
              </button>
            </div>
          </div>
          <div className="flex gap-12 border-t border-xmr-border/20 pt-6 uppercase font-black">
            <div><span className="text-xs font-black text-xmr-dim uppercase">Unlocked</span><div className="text-2xl font-black text-xmr-green">{parseFloat(currentAcc?.unlockedBalance || '0').toFixed(4)}</div></div>
            <div><span className="text-xs font-black text-xmr-dim uppercase">Active_Outputs</span><div className="text-2xl font-black opacity-40 text-xmr-green">{outputs?.length || 0}</div></div>
          </div>
        </Card>

        <div className="flex flex-col gap-6 font-black">
          <Card className="flex-grow flex flex-col justify-between p-4!">
            <div className="flex justify-between items-start font-black">
              <span className="text-xs text-xmr-dim uppercase tracking-widest font-black">Identity_Status</span>
              <button onClick={revealSeed} className="text-xmr-green hover:text-xmr-accent transition-all cursor-pointer">
                <Key size={16} />
              </button>
            </div>
            <div className="p-3 bg-xmr-base border border-xmr-border/30 rounded-sm font-black overflow-hidden">
              <div className="flex justify-between items-center mb-1 font-black"><span className="text-xs opacity-50 text-xmr-green font-black uppercase">SESSION_ADDRESS</span></div>
              <AddressDisplay address={address} className="text-[11px] " />
            </div>
            <div className="space-y-1.5 border-t border-xmr-border/20 pt-4 font-black">
              <div className="flex justify-between text-[11px] uppercase font-black">
                <span className="opacity-40 text-xmr-green">Uplink:</span>
                <span className={`font-black flex items-center gap-1.5 ${isSyncing ? 'text-xmr-accent animate-pulse' : 'text-xmr-green'}`}>
                  {isSyncing && <Loader2 size={10} className="animate-spin" />}
                  {status}
                </span>
              </div>
              <div className="flex justify-between text-[11px] uppercase font-black"><span className="opacity-40 text-xmr-green">Height:</span><span className="text-xmr-green">{currentHeight || '---'}</span></div>
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-4 font-black">
            <button disabled={isSyncing} onClick={() => setModals(prev => ({ ...prev, receive: true }))} className="py-4 border border-xmr-green text-xmr-green font-black uppercase text-xs tracking-widest hover:bg-xmr-green hover:text-xmr-base transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"><Download size={16} /> Receive</button>
            <button disabled={isSyncing} onClick={() => setModals(prev => ({ ...prev, send: true }))} className="py-4 border border-xmr-accent text-xmr-accent font-black uppercase text-xs tracking-widest hover:bg-xmr-accent hover:text-xmr-base transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"><Send size={16} /> Dispatch</button>
          </div>
        </div>
      </div>

      {/* 3. TABS NAVIGATION */}
      <div className="flex gap-4 border-b border-xmr-border/20">
        {['ledger', 'coins', 'addresses', 'contacts'].map((t) => (
          <button
            key={t}
            onClick={() => setTab(t as any)}
            className={`px-6 py-3 text-xs font-black uppercase tracking-widest transition-all border-b-2 ${tab === t ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}
          >
            {t.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* 4. TAB CONTENT */}
      <div className="min-h-[400px]">
        {tab === 'ledger' && <TransactionLedger txs={txs} />}
        {tab === 'coins' && <CoinControl outputs={outputs} onSendFromCoin={(_keyImage, _amount) => { setModals(prev => ({ ...prev, send: true })); }} />}
        {tab === 'addresses' && <AddressList
          subaddresses={subaddresses}
          handleCopy={handleCopy}
          onUpdateLabel={setSubaddressLabel}
          onRowClick={(s) => { setSelectedSubaddress(s); setModals(prev => ({ ...prev, receive: true })); }}
          onVanishSubaddress={vanishSubaddress}
          onSendFrom={(idx) => { setDispatchSubIndex(idx); setModals(prev => ({ ...prev, send: true })); }}
          isSyncing={status === 'SYNCING'}
        />}
        {tab === 'contacts' && <AddressBook
          contacts={contacts}
          onAddContact={(c) => saveContacts([...contacts, c])}
          onRemoveContact={(idx) => saveContacts(contacts.filter((_, i) => i !== idx))}
          onDispatch={(addr) => { setDispatchAddr(addr); setModals(prev => ({ ...prev, send: true })); }}
          handleCopy={handleCopy}
        />}
      </div>

      {/* 5. MODALS */}
      <VaultModals
        showSeed={modals.seed}
        onCloseSeed={() => setModals(prev => ({ ...prev, seed: false }))}
        mnemonic={mnemonic}
        showReceive={modals.receive}
        onCloseReceive={() => { setModals(prev => ({ ...prev, receive: false })); setSelectedSubaddress(null); }}
        onCreateSub={createSubaddress}
        selectedSubaddress={selectedSubaddress}
        showSend={modals.send}
        onCloseSend={() => { setModals(prev => ({ ...prev, send: false })); setDispatchSubIndex(undefined); }}
        onSend={sendXmr}
        isSending={isSending}
        initialAddr={dispatchAddr}
        sourceSubaddressIndex={dispatchSubIndex}
      />

      {/* 6. ACCOUNT SELECTOR DRAWER */}
      {showAccountDropdown && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/50 backdrop-blur-sm animate-in fade-in duration-200">
          <div
            ref={dropdownRef}
            className="w-[450px] max-w-[90vw] h-full bg-xmr-base border-l border-xmr-border/50 shadow-2xl flex flex-col font-mono animate-in slide-in-from-right duration-300"
          >
            <div className="flex justify-between items-center p-6 border-b border-xmr-border/20 relative">
              <h3 className="text-lg font-black uppercase text-xmr-green tracking-widest">Account_Manager</h3>
              <button
                onClick={() => setShowAccountDropdown(false)}
                className="text-xmr-dim hover:text-xmr-green cursor-pointer"
              >
                ✕
              </button>
            </div>

            <div className="flex px-6 py-3 border-b border-xmr-border/20 text-[11px] uppercase font-black text-xmr-dim tracking-widest bg-xmr-base">
              <div className="w-12">IDX</div>
              <div className="flex-1">Identity & Address</div>
              <div className="w-24 text-right">Balance</div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {accounts.map(acc => (
                <div
                  key={acc.index}
                  className={`flex items-center px-6 py-4 border-b border-xmr-border/10 cursor-pointer hover:bg-xmr-green/10 transition-colors group ${acc.index === selectedAccountIndex ? 'bg-xmr-green/5' : ''}`}
                  onClick={() => {
                    setSelectedAccountIndex(acc.index);
                    setShowAccountDropdown(false);
                  }}
                >
                  <div className="w-12 text-xs text-xmr-dim font-black flex items-center h-full pt-1">
                    {acc.index.toString().padStart(2, '0')}
                  </div>
                  <div className="flex-1 flex flex-col justify-center pr-4">
                    {editingAccountId === acc.index ? (
                      <input
                        autoFocus
                        value={editAccountName}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setEditAccountName(e.target.value)}
                        onBlur={async () => {
                          if (editAccountName.trim() && editAccountName !== acc.label) {
                            await vault.renameAccount(acc.index, editAccountName.trim());
                          }
                          setEditingAccountId(null);
                        }}
                        onKeyDown={async (e) => {
                          if (e.key === 'Enter') {
                            if (editAccountName.trim() && editAccountName !== acc.label) {
                              await vault.renameAccount(acc.index, editAccountName.trim());
                            }
                            setEditingAccountId(null);
                          } else if (e.key === 'Escape') {
                            setEditingAccountId(null);
                          }
                        }}
                        className="bg-xmr-base border border-xmr-green text-xmr-green text-xs font-black p-1 uppercase outline-none mb-0.5 w-full"
                      />
                    ) : (
                      <div className="flex items-center gap-2 mb-0.5 group/edit">
                        <span className="text-xs text-xmr-green break-all font-black uppercase">
                          {acc.label || 'UNTITLED'}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditAccountName(acc.label || '');
                            setEditingAccountId(acc.index);
                          }}
                          className="opacity-0 group-hover/edit:opacity-100 text-xmr-dim hover:text-xmr-accent transition-all cursor-pointer"
                        >
                          <Edit2 size={10} />
                        </button>
                      </div>
                    )}
                    <span className="text-xs text-xmr-dim font-black tracking-widest opacity-60">
                      {acc.baseAddress?.substring(0, 16)}...{acc.baseAddress?.substring(acc.baseAddress.length - 8)}
                    </span>
                  </div>
                  <div className="w-24 text-right flex flex-col justify-center items-end">
                    <span className="text-sm text-xmr-green font-black">{parseFloat(acc.balance).toFixed(4)}</span>
                    <span className="text-[11px] text-xmr-dim font-black uppercase mt-0.5">XMR</span>
                  </div>
                </div>
              ))}
            </div>

            <div
              onClick={() => {
                handleOpenCreateModal();
                setShowAccountDropdown(false);
              }}
              className="p-6 text-center text-xs text-xmr-accent hover:bg-xmr-accent/10 border-t border-xmr-border/50 cursor-pointer font-black uppercase transition-colors"
            >
              + Generate New Account
            </div>
          </div>
        </div>
      )}
    </div>
  );
}