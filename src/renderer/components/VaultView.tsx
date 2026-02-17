import React, { useState, useEffect } from 'react';
import { Skull, RefreshCw, Key, Send, Download, Wind } from 'lucide-react';
import { StealthStep } from '../../services/stealth/types';
import { useStats } from '../../hooks/useStats';
import { useTor } from '../../contexts/TorContext';
import { Card } from '../Card';

// Subcomponents
import { TransactionLedger } from './TransactionLedger';
import { AddressList } from './AddressList';
import { CoinControl } from './CoinControl';
import { AddressBook } from './AddressBook';
import { VaultModals } from './VaultModals';

interface VaultViewProps {
  setView: (v: any) => void;
  vault: any; 
  handleBurn: () => void;
}

export function VaultView({ setView, vault, handleBurn }: VaultViewProps) {
  const { balance, address, subaddresses, outputs, refresh, status, isSending, sendXmr, createSubaddress, churn, txs, currentHeight, activeId } = vault;
  const { stats } = useStats();
  const { torFetch } = useTor();
  
  const [tab, setTab] = useState<'ledger' | 'addresses' | 'coins' | 'contacts'>('ledger');
  const [modals, setModals] = useState({ seed: false, receive: false, send: false });
  const [mnemonic, setMnemonic] = useState('');
  const [isChurning, setIsChurning] = useState(false);
  const [contacts, setContacts] = useState<any[]>([]);
  const [dispatchAddr, setDispatchAddr] = useState('');

  // Load Contacts
  useEffect(() => {
    (window as any).api.getConfig(`address_book_${activeId}`).then((data: any) => setContacts(data || []));
  }, [activeId]);

  const saveContacts = async (updated: any[]) => {
    setContacts(updated);
    await (window as any).api.setConfig(`address_book_${activeId}`, updated);
  };

  const handleChurn = async () => {
    if (!confirm("INITIATE_CHURN? This will break on-chain linkability.")) return;
    setIsChurning(true);
    try { await churn(); alert("CHURN_BROADCASTED."); } 
    catch (e: any) { alert(`CHURN_FAILED: ${e.message}`); } 
    finally { setIsChurning(false); }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    // You could add a toast here later
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6 py-2 animate-in fade-in zoom-in-95 duration-300 font-black relative">
      
      {/* 1. HEADER */}
      <div className="flex justify-between items-end border-b border-xmr-border/30 pb-4 relative z-10 font-black">
        <div>
           <button onClick={() => setView('home')} className="text-[10px] text-xmr-dim hover:text-xmr-green mb-1 flex items-center gap-1 cursor-pointer font-black transition-all uppercase tracking-widest">[ DASHBOARD ]</button>
           <h2 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-mono leading-none">Vault_Storage</h2>
        </div>
        <div className="flex gap-2 font-black">
          <button onClick={handleBurn} className="px-3 py-1.5 border border-red-900/50 text-red-500 text-[9px] font-black hover:bg-red-500/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><Skull size={10} /> Burn_ID</button>
          <button onClick={refresh} className="px-3 py-1.5 border border-xmr-border text-[9px] font-black hover:bg-xmr-green/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><RefreshCw size={10} className={status === StealthStep.SYNCING || isSending ? 'animate-spin' : ''} /> Sync_Ledger</button>
        </div>
      </div>

      {/* 2. TOP GRID (Balances & ID) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative z-10 font-black font-mono">
        <Card topGradientAccentColor="xmr-green" className="lg:col-span-2 flex flex-col justify-between shadow-[0_0_30px_rgba(0,255,65,0.05)]">
          <div className="flex justify-between items-start">
            <div>
              <span className="text-[10px] text-xmr-dim uppercase font-bold tracking-[0.4em] font-black">Available_Liquidity</span>
              <div className="text-7xl font-black mt-4 text-xmr-green drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">{parseFloat(balance.total).toFixed(4)} <span className="text-2xl text-xmr-dim uppercase font-black">XMR</span></div>
              <div className="text-xl font-black text-xmr-green/60 mt-1 uppercase tracking-[0.2em]">≈ ${stats?.price.street ? (parseFloat(balance.total) * stats.price.street).toLocaleString(undefined, { minimumFractionDigits: 2 }) : '---.--'} <span className="text-xs opacity-50">USD</span></div>
            </div>
            <button disabled={isChurning || parseFloat(balance.unlocked) <= 0} onClick={handleChurn} className={`flex flex-col items-center gap-2 p-4 border border-xmr-green/20 hover:bg-xmr-green/5 transition-all group cursor-pointer ${isChurning ? 'animate-pulse' : ''}`}>
               <Wind size={24} className={isChurning ? 'animate-spin' : 'group-hover:rotate-180 transition-transform duration-700'} />
               <span className="text-[8px] font-black uppercase tracking-widest">Churn_All</span>
            </button>
          </div>
          <div className="flex gap-12 border-t border-xmr-border/20 pt-6 uppercase font-black">
            <div><span className="text-[10px] font-black text-xmr-dim uppercase">Unlocked</span><div className="text-2xl font-black text-xmr-green">{parseFloat(balance.unlocked).toFixed(4)}</div></div>
            <div><span className="text-[10px] font-black text-xmr-dim uppercase">Active_Coins</span><div className="text-2xl font-black opacity-40 text-xmr-green">{outputs?.length || 0}</div></div>
          </div>
        </Card>

        <div className="flex flex-col gap-6 font-black">
          <Card className="flex-grow flex flex-col justify-between">
            <div className="flex justify-between items-start font-black">
              <span className="text-[10px] text-xmr-dim uppercase font-bold tracking-widest font-black">Identity_Status</span>
              <button onClick={async () => { const s = await (window as any).api.getConfig(`master_seed_${activeId}`); setMnemonic(s); setModals(prev => ({...prev, seed: true})); }} className="text-xmr-green hover:text-xmr-accent transition-all cursor-pointer"><Key size={16} /></button>
            </div>
            <div className="p-3 bg-xmr-base border border-xmr-border/30 rounded-sm font-black overflow-hidden">
              <div className="flex justify-between items-center mb-1 font-black"><span className="text-[8px] opacity-50 text-xmr-green font-black uppercase">SESSION_ADDRESS</span></div>
              <code className="text-[9px] text-xmr-green break-all leading-tight block h-12 overflow-hidden italic font-black font-mono">{address || 'GENERATING...'}</code>
            </div>
            <div className="space-y-1.5 border-t border-xmr-border/20 pt-4 font-black">
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-xmr-green">Uplink:</span><span className="text-xmr-green font-black">{status}</span></div>
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-xmr-green">Height:</span><span className="text-xmr-green">{currentHeight}</span></div>
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-4 font-black">
            <button onClick={() => setModals(prev => ({...prev, receive: true}))} className="py-4 border border-xmr-green text-xmr-green font-black uppercase text-xs tracking-widest hover:bg-xmr-green hover:text-xmr-base transition-all flex items-center justify-center gap-2 cursor-pointer"><Download size={16}/> Receive</button>
            <button onClick={() => setModals(prev => ({...prev, send: true}))} className="py-4 border border-xmr-accent text-xmr-accent font-black uppercase text-xs tracking-widest hover:bg-xmr-accent hover:text-xmr-base transition-all flex items-center justify-center gap-2 cursor-pointer"><Send size={16}/> Dispatch</button>
          </div>
        </div>
      </div>

      {/* 3. TABS NAVIGATION */}
      <div className="flex gap-4 border-b border-xmr-border/20">
         <button onClick={() => setTab('ledger')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'ledger' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Ledger</button>
         <button onClick={() => setTab('coins')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'coins' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Coin_Control</button>
         <button onClick={() => setTab('addresses')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'addresses' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Subaddresses</button>
         <button onClick={() => setTab('contacts')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'contacts' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Address_Book</button>
      </div>

      {/* 4. TAB CONTENT */}
      <div className="min-h-[400px]">
        {tab === 'ledger' && <TransactionLedger txs={txs} />}
        {tab === 'coins' && <CoinControl outputs={outputs} />}
        {tab === 'addresses' && <AddressList subaddresses={subaddresses} handleCopy={handleCopy} />}
        {tab === 'contacts' && <AddressBook 
          contacts={contacts} 
          onAddContact={(c) => saveContacts([...contacts, c])} 
          onRemoveContact={(idx) => saveContacts(contacts.filter((_, i) => i !== idx))} 
          onDispatch={(addr) => { setDispatchAddr(addr); setModals(prev => ({...prev, send: true})); }}
          handleCopy={handleCopy}
        />}
      </div>

      {/* 5. MODALS */}
      <VaultModals 
        showSeed={modals.seed} 
        onCloseSeed={() => setModals(prev => ({...prev, seed: false}))}
        mnemonic={mnemonic}
        showReceive={modals.receive}
        onCloseReceive={() => setModals(prev => ({...prev, receive: false}))}
        onCreateSub={createSubaddress}
        showSend={modals.send}
        onCloseSend={() => setModals(prev => ({...prev, send: false}))}
        onSend={sendXmr}
        isSending={isSending}
        torFetch={torFetch}
        initialAddr={dispatchAddr}
      />
    </div>
  );
}
