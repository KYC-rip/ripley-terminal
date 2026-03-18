import React, { useState, useEffect, useRef } from 'react';
import { RefreshCw, Key, Send, Download, Wind, Loader2, Edit2, Scissors, MoreVertical, Plus } from 'lucide-react';
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
  appConfig: any;
}

export function VaultView({ setView, vault, handleBurn, appConfig }: VaultViewProps) {
  const {
    accounts, selectedAccountIndex, setSelectedAccountIndex,
    balance, address, subaddresses, outputs, refresh,
    status, isSending, sendXmr, createSubaddress,
    churn, splinter, txs, currentHeight, totalHeight, syncPercent, activeId, setSubaddressLabel,
    vanishSubaddress, requestedAction
  } = vault;
  const [tab, setTab] = useState<'ledger' | 'addresses' | 'coins' | 'contacts'>('ledger');
  const [modals, setModals] = useState({ seed: false, receive: false, send: false, splinter: false, churn: false });
  const [mnemonic, setMnemonic] = useState('');
  const [contacts, setContacts] = useState<any[]>([]);
  const [dispatchAddr, setDispatchAddr] = useState('');
  const [selectedSubaddress, setSelectedSubaddress] = useState<any>(null);
  const [dispatchSubIndex, setDispatchSubIndex] = useState<number | undefined>(undefined);
  const [showCardMenu, setShowCardMenu] = useState(false);
  const [editingAccountId, setEditingAccountId] = useState<number | null>(null);
  const [editAccountName, setEditAccountName] = useState('');
  const [hideZeroBalances, setHideZeroBalances] = useState(false);
  const [switching, setSwitching] = useState(false);

  const currentAcc = accounts.find(a => a.index === selectedAccountIndex);
  const currentAccBalance = currentAcc?.balance || '0.0000';
  const { fiatText: usdValue } = useFiatValue('XMR', currentAccBalance, true);

  useEffect(() => {
    const loadAddressBook = async () => {
      const bookKey = `address_book_${activeId}` as keyof typeof appConfig;
      setContacts((appConfig as any)[bookKey] || []);
      setHideZeroBalances(!!appConfig.hide_zero_balances);
    };
    if (appConfig) loadAddressBook();
  }, [activeId, appConfig]);

  const cardMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (requestedAction) {
      if (requestedAction === 'OPEN_SEND') setModals(prev => ({ ...prev, send: true }));
      else if (requestedAction === 'OPEN_RECEIVE') setModals(prev => ({ ...prev, receive: true }));
      else if (requestedAction === 'OPEN_CHURN') setModals(prev => ({ ...prev, churn: true }));
      else if (requestedAction === 'OPEN_SPLINTER') setModals(prev => ({ ...prev, splinter: true }));
      vault.setRequestedAction(null);
    }
  }, [requestedAction, vault]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (cardMenuRef.current && !cardMenuRef.current.contains(event.target as Node)) {
        setShowCardMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Card switch animation
  useEffect(() => {
    setSwitching(true);
    const t = setTimeout(() => setSwitching(false), 150);
    return () => clearTimeout(t);
  }, [selectedAccountIndex]);

  const saveContacts = async (updated: any[]) => {
    setContacts(updated);
    const currentConfig = await window.api.getConfig();
    await window.api.saveConfigAndReload({
      ...currentConfig,
      [`address_book_${activeId}`]: updated
    });
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

  const handleToggleFilter = async (val: boolean) => {
    setHideZeroBalances(val);
    const updatedConfig = { ...appConfig, hide_zero_balances: val };
    await window.api.saveConfigOnly?.(updatedConfig) || await window.api.saveConfigAndReload(updatedConfig);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const isSyncing = status === 'SYNCING' || status === 'READY';
  const isFullySynced = status === 'SYNCED';

  const cycleAccount = () => {
    if (accounts.length <= 1) return;
    const currentIdx = accounts.findIndex(a => a.index === selectedAccountIndex);
    const nextIdx = (currentIdx + 1) % accounts.length;
    setSelectedAccountIndex(accounts[nextIdx].index);
  };

  const hasNoBalance = parseFloat(currentAcc?.unlockedBalance || '0') <= 0;

  const quickActions = [
    { label: 'Dispatch', icon: Send, onClick: () => setModals(prev => ({ ...prev, send: true })), disabled: isSyncing },
    { label: 'Receive', icon: Download, onClick: () => setModals(prev => ({ ...prev, receive: true })), disabled: isSyncing },
    { label: 'Churn', icon: Wind, onClick: () => setModals(prev => ({ ...prev, churn: true })), disabled: isSyncing || isSending || hasNoBalance },
    { label: 'Splinter', icon: Scissors, onClick: () => setModals(prev => ({ ...prev, splinter: true })), disabled: isSyncing || isSending || hasNoBalance },
    { label: 'Sync', icon: RefreshCw, onClick: refresh, disabled: false, spin: isSyncing || isSending },
  ];

  return (
    <div className="max-w-6xl mx-auto space-y-6 py-2 pt-0 animate-in fade-in zoom-in-95 duration-300 font-black relative">

      {/* 1. HEADER */}
      <div className="flex justify-between items-end border-b border-xmr-border/30 pb-4 relative z-10 font-black">
        <div>
          <button onClick={() => setView('home')} className="text-xs text-xmr-dim hover:text-xmr-green mb-1 flex items-center gap-1 cursor-pointer font-black transition-all uppercase tracking-widest">[ DASHBOARD ]</button>
          <h2 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-mono leading-none">Vault_Storage</h2>
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

      {/* 2. CARD STACK + IDENTITY STATUS */}
      <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6 relative z-10 font-black font-mono">

        {/* LEFT: Card Stack + Quick Actions */}
        <div className="flex flex-col gap-5">

          {/* Card Stack */}
          <div className="relative h-[220px] cursor-pointer" style={{ perspective: '800px' }} onClick={cycleAccount}>
            {/* Background card 3 (deepest) */}
            {accounts.length >= 3 && (
              <div
                className="absolute top-0 left-6 right-6 h-[200px] bg-xmr-surface border border-xmr-border/15 rounded-lg"
                style={{ transform: 'translateY(0px) scale(0.92)', opacity: 0.3 }}
              />
            )}
            {/* Background card 2 */}
            {accounts.length >= 2 && (
              <div
                className="absolute top-0 left-3.5 right-3.5 h-[200px] bg-xmr-surface border border-xmr-border/20 rounded-lg"
                style={{ transform: 'translateY(6px) scale(0.96)', opacity: 0.5 }}
              />
            )}

            {/* Main card (active account) */}
            <div
              className={`absolute top-0 left-0 right-0 h-[200px] bg-gradient-to-br from-xmr-green/5 via-xmr-green/8 to-xmr-green/3 bg-xmr-surface border border-xmr-green/40 rounded-lg p-6 flex flex-col justify-between shadow-[0_8px_32px_rgba(0,0,0,0.5)] transition-all duration-150 ${switching ? 'scale-[0.97] opacity-70' : 'scale-100 opacity-100'}`}
              style={{ transform: `translateY(14px) ${switching ? 'scale(0.97)' : 'scale(1)'}` }}
            >
              {/* Top glow */}
              <div className="absolute top-0 left-0 right-0 h-[2px] bg-gradient-to-r from-transparent via-xmr-green/50 to-transparent rounded-t-lg" />

              {/* Watermark */}
              <div className="absolute right-5 bottom-4 text-7xl font-black text-xmr-green/5 tracking-tighter select-none pointer-events-none">XMR</div>

              {/* Card header */}
              <div className="flex justify-between items-start relative z-10">
                <div>
                  <div className="text-[11px] text-xmr-dim font-bold tracking-[0.2em] uppercase">ACCT #{String(selectedAccountIndex).padStart(2, '0')}</div>
                  {editingAccountId === selectedAccountIndex ? (
                    <input
                      autoFocus
                      value={editAccountName}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setEditAccountName(e.target.value)}
                      onBlur={async () => {
                        if (editAccountName.trim() && editAccountName !== currentAcc?.label) {
                          await vault.renameAccount(selectedAccountIndex, editAccountName.trim());
                        }
                        setEditingAccountId(null);
                      }}
                      onKeyDown={async (e) => {
                        if (e.key === 'Enter') {
                          if (editAccountName.trim() && editAccountName !== currentAcc?.label) {
                            await vault.renameAccount(selectedAccountIndex, editAccountName.trim());
                          }
                          setEditingAccountId(null);
                        } else if (e.key === 'Escape') {
                          setEditingAccountId(null);
                        }
                      }}
                      className="bg-xmr-base border border-xmr-green text-xmr-green text-sm font-black p-1 uppercase outline-none mt-0.5 w-48"
                    />
                  ) : (
                    <div className="text-sm font-black uppercase tracking-[0.15em] text-xmr-green mt-0.5">
                      {currentAcc?.label || 'UNTITLED_IDENTITY'}
                    </div>
                  )}
                </div>

                {/* Three-dot menu */}
                <div className="relative" ref={cardMenuRef}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowCardMenu(!showCardMenu); }}
                    className="w-7 h-7 flex items-center justify-center border border-xmr-border/20 rounded-md text-xmr-dim hover:text-xmr-green hover:border-xmr-green/50 hover:bg-xmr-green/10 transition-all cursor-pointer"
                  >
                    <MoreVertical size={14} />
                  </button>
                  {showCardMenu && (
                    <div className="absolute right-0 top-9 bg-xmr-base border border-xmr-border/50 rounded-md shadow-xl z-50 min-w-[180px] py-1 animate-in fade-in zoom-in-95 duration-150">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditAccountName(currentAcc?.label || '');
                          setEditingAccountId(selectedAccountIndex);
                          setShowCardMenu(false);
                        }}
                        className="w-full px-4 py-2.5 text-left text-[11px] font-black uppercase tracking-widest text-xmr-dim hover:text-xmr-green hover:bg-xmr-green/10 transition-all flex items-center gap-2 cursor-pointer"
                      >
                        <Edit2 size={10} /> Rename
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleOpenCreateModal();
                          setShowCardMenu(false);
                        }}
                        className="w-full px-4 py-2.5 text-left text-[11px] font-black uppercase tracking-widest text-xmr-accent hover:bg-xmr-accent/10 transition-all flex items-center gap-2 cursor-pointer"
                      >
                        <Plus size={10} /> New Account
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Balance */}
              <div className="flex flex-col gap-0.5 relative z-10">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-4xl font-black text-xmr-green leading-none">{currentAccBalance}</span>
                  <span className="text-base text-xmr-dim font-bold">XMR</span>
                </div>
                {usdValue && (
                  <div className="text-xs font-bold text-xmr-dim/60 uppercase tracking-[0.1em]">
                    {usdValue} USD
                  </div>
                )}
              </div>

              {/* Card footer */}
              <div className="flex justify-between items-end relative z-10">
                <div className="text-[10px] text-xmr-dim/30 tracking-wider">
                  {currentAcc?.baseAddress?.substring(0, 8)}...{currentAcc?.baseAddress?.substring((currentAcc?.baseAddress?.length || 8) - 6)}
                </div>
                {/* Dot indicators */}
                <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {accounts.map(acc => (
                    <button
                      key={acc.index}
                      onClick={() => setSelectedAccountIndex(acc.index)}
                      className={`w-[7px] h-[7px] rounded-full transition-all cursor-pointer ${acc.index === selectedAccountIndex
                        ? 'bg-xmr-green shadow-[0_0_8px_var(--color-xmr-green)]'
                        : 'bg-xmr-green/30 hover:bg-xmr-green/60'
                      }`}
                      title={acc.label || `Account ${acc.index}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Quick Actions Row */}
          <div className="flex gap-3 justify-center">
            {quickActions.map(action => (
              <button
                key={action.label}
                onClick={action.onClick}
                disabled={action.disabled}
                className="flex flex-col items-center gap-1.5 group cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <div className="w-[52px] h-[52px] rounded-full border border-xmr-green/30 flex items-center justify-center bg-xmr-base text-xmr-green group-hover:border-xmr-green/80 group-hover:bg-xmr-green/10 group-hover:scale-105 transition-all disabled:group-hover:scale-100">
                  <action.icon size={18} className={action.spin ? 'animate-spin' : ''} />
                </div>
                <span className="text-[9px] font-black uppercase tracking-[0.15em] text-xmr-dim group-hover:text-xmr-green transition-colors">
                  {action.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* RIGHT: Identity Status (enhanced with Unlocked + Outputs) */}
        <Card className="flex flex-col justify-between p-4! h-fit">
          <div className="flex justify-between items-start font-black">
            <span className="text-xs text-xmr-dim uppercase tracking-widest font-black">Identity_Status</span>
            <button onClick={revealSeed} className="text-xmr-green hover:text-xmr-accent transition-all cursor-pointer">
              <Key size={16} />
            </button>
          </div>
          <div className="p-3 bg-xmr-base border border-xmr-border/30 rounded-sm font-black overflow-hidden mt-3">
            <div className="flex justify-between items-center mb-1 font-black"><span className="text-xs opacity-50 text-xmr-green font-black uppercase">SESSION_ADDRESS</span></div>
            <AddressDisplay address={address} className="text-[11px] " />
          </div>
          <div className="space-y-1.5 border-t border-xmr-border/20 pt-4 mt-3 font-black">
            <div className="flex justify-between text-[11px] uppercase font-black">
              <span className="opacity-40 text-xmr-green">Uplink:</span>
              <span className={`font-black flex items-center gap-1.5 ${isSyncing ? 'text-xmr-accent animate-pulse' : 'text-xmr-green'}`}>
                {isSyncing && <Loader2 size={10} className="animate-spin" />}
                {status}
              </span>
            </div>
            <div className="flex justify-between text-[11px] uppercase font-black"><span className="opacity-40 text-xmr-green">Height:</span><span className="text-xmr-green">{currentHeight || '---'}</span></div>
            <div className="flex justify-between text-[11px] uppercase font-black"><span className="opacity-40 text-xmr-green">Unlocked:</span><span className="text-xmr-green">{parseFloat(currentAcc?.unlockedBalance || '0').toFixed(4)}</span></div>
            <div className="flex justify-between text-[11px] uppercase font-black"><span className="opacity-40 text-xmr-green">Outputs:</span><span className="text-xmr-green">{outputs?.length || 0}</span></div>
          </div>
        </Card>
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
        {tab === 'ledger' && <TransactionLedger txs={txs} subaddresses={subaddresses} />}
        {tab === 'coins' && <CoinControl outputs={outputs} onSendFromCoin={(_keyImage, _amount) => { setModals(prev => ({ ...prev, send: true })); }} />}
        {tab === 'addresses' && <AddressList
          subaddresses={hideZeroBalances ? subaddresses.filter(s => parseFloat(s.balance) > 0 || s.index === 0) : subaddresses}
          handleCopy={handleCopy}
          onUpdateLabel={setSubaddressLabel}
          onRowClick={(s) => { setSelectedSubaddress(s); setModals(prev => ({ ...prev, receive: true })); }}
          onVanishSubaddress={vanishSubaddress}
          onSendFrom={(idx) => { setDispatchSubIndex(idx); setModals(prev => ({ ...prev, send: true })); }}
          isSyncing={status === 'SYNCING'}
          hideZeroBalances={hideZeroBalances}
          onToggleFilter={handleToggleFilter}
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
        showSplinter={modals.splinter}
        onCloseSplinter={() => setModals(prev => ({ ...prev, splinter: false }))}
        onSplinter={splinter}
        showChurn={modals.churn}
        onCloseChurn={() => setModals(prev => ({ ...prev, churn: false }))}
        onChurn={churn}
        unlockedBalance={parseFloat(currentAcc?.unlockedBalance || '0')}
      />
    </div>
  );
}
