import React, { useState, useEffect } from 'react';
import { Skull, RefreshCw, Copy, Check, Key, ShieldAlert, Send, ArrowDownLeft, ArrowUpRight, X, Download, PlusCircle, Book, Tag, Wallet } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { StealthStep } from '../services/stealth/types';
import { useStats } from '../hooks/useStats';
import { useTor } from '../contexts/TorContext';
import { Card } from './Card';

interface VaultViewProps {
  setView: (v: any) => void;
  vault: any; 
  handleBurn: () => void;
}

export function VaultView({ setView, vault, handleBurn }: VaultViewProps) {
  const { balance, address, subaddresses, logs, refresh, status, isSending, sendXmr, createSubaddress, txs, currentHeight } = vault;
  const { stats } = useStats();
  const { torFetch } = useTor();
  
  // Tabs
  const [tab, setTab] = useState<'ledger' | 'addresses' | 'contacts'>('ledger');

  // Modals
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [showSendModal, setShowSendModal] = useState(false);
  
  // Identity State
  const [mnemonic, setMnemonic] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  
  // Send/Receive State
  const [destAddr, setDestAddr] = useState('');
  const [sendAmount, setAmount] = useState('');
  const [receiveLabel, setReceiveLabel] = useState('');
  const [isBanned, setIsBanned] = useState(false);

  // Address Book (Contact management)
  const [contacts, setContacts] = useState<any[]>([]);
  const [showAddContact, setShowAddContact] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', address: '' });

  // Load Address Book
  useEffect(() => {
    (window as any).api.getConfig(`address_book_${vault.activeId}`).then((data: any) => {
      setContacts(data || []);
    });
  }, [vault.activeId]);

  const saveContacts = async (updated: any[]) => {
    setContacts(updated);
    await (window as any).api.setConfig(`address_book_${vault.activeId}`, updated);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleCreateSub = async () => {
    await createSubaddress(receiveLabel || 'Receive');
    setReceiveLabel('');
    setShowReceiveModal(false);
  };

  const handleSend = async () => {
    if (!destAddr || !sendAmount) return;
    try {
      await sendXmr(destAddr, parseFloat(sendAmount));
      setDestAddr(''); setAmount('');
      setShowSendModal(false);
      alert("SUCCESS: BROADCASTED.");
    } catch (e: any) { alert(`FAIL: ${e.message}`); }
  };

  useEffect(() => {
    if (destAddr.length > 30) {
      torFetch(`https://api.kyc.rip/v1/tools/ban-list?address=${destAddr}`)
        .then(data => setIsBanned(data.results && data.results.length > 0))
        .catch(() => setIsBanned(false));
    } else setIsBanned(false);
  }, [destAddr, torFetch]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 py-2 animate-in fade-in zoom-in-95 duration-300 font-black relative">
      {/* SEED MODAL */}
      {showSeedModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-lg bg-white text-black p-8 border-4 border-red-600 relative">
            <button onClick={() => setShowSeedModal(false)} className="absolute top-4 right-4"><X size={24} /></button>
            <div className="space-y-6 font-black">
              <div className="flex items-center gap-3 text-red-600 animate-pulse font-black"><ShieldAlert size={32} /><h3 className="text-2xl font-black uppercase tracking-tighter">Backup_Protocol</h3></div>
              <div className="p-4 bg-black/5 border border-black/10 rounded-sm font-black text-sm leading-loose select-text text-black">{mnemonic}</div>
              <button onClick={() => setShowSeedModal(false)} className="w-full py-4 bg-black text-white font-black uppercase tracking-[0.2em] font-mono">I_HAVE_SECURED_THE_KEY</button>
            </div>
          </div>
        </div>
      )}

      {/* RECEIVE MODAL */}
      {showReceiveModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
          <div className="w-full max-w-md bg-xmr-surface border border-xmr-border p-8 space-y-8 relative font-black">
            <button onClick={() => setShowReceiveModal(false)} className="absolute top-4 right-4 text-xmr-dim hover:text-xmr-green transition-all"><X size={24} /></button>
            <div className="text-center space-y-2">
              <h3 className="text-2xl font-black italic uppercase text-xmr-green">Generate_Uplink</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">Define subaddress parameters</p>
            </div>
            <div className="space-y-6">
              <div className="space-y-2">
                 <label className="text-[9px] font-black text-xmr-dim uppercase ml-1 flex items-center gap-2"><Tag size={10}/> Purpose_Label</label>
                 <input 
                   autoFocus
                   type="text" 
                   value={receiveLabel} 
                   onChange={(e) => setReceiveLabel(e.target.value)} 
                   placeholder="e.g. Donation, Swap, etc." 
                   className="w-full bg-xmr-base border border-xmr-border p-3 text-[11px] text-xmr-green focus:border-xmr-green outline-none" 
                 />
              </div>
              <button onClick={handleCreateSub} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-white transition-all flex items-center justify-center gap-2 font-black"><PlusCircle size={16}/> Generate_Tactical_Address</button>
            </div>
          </div>
        </div>
      )}

      {/* SEND MODAL */}
      {showSendModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
          <div className="w-full max-w-lg bg-xmr-surface border border-xmr-accent/50 p-8 space-y-6 relative font-black">
            <button onClick={() => setShowSendModal(false)} className="absolute top-4 right-4 text-xmr-dim hover:text-xmr-green"><X size={24} /></button>
            <div className="text-center space-y-2 mb-4 font-black">
              <h3 className="text-2xl font-black italic uppercase text-xmr-accent">Dispatch_Sequence</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">Constructing outbound transaction</p>
            </div>
            <div className="space-y-4 font-black">
              <div className="space-y-1 font-black">
                 <div className="flex justify-between items-center font-black">
                    <label className="text-[9px] font-black text-xmr-dim uppercase font-black">Destination_Address</label>
                    {isBanned && <span className="text-[8px] text-red-500 font-black animate-pulse uppercase tracking-tighter">Intercepted</span>}
                 </div>
                 <input type="text" placeholder="4... / 8..." value={destAddr} onChange={(e) => setDestAddr(e.target.value)} className={`w-full bg-xmr-base border p-3 text-[10px] text-xmr-green focus:border-xmr-accent outline-none font-black transition-colors ${isBanned ? 'border-red-600' : 'border-xmr-border'}`} />
              </div>
              <div className="space-y-1 font-black">
                 <label className="text-[9px] font-black text-xmr-dim uppercase font-black">Amount (XMR)</label>
                 <input type="number" placeholder="0.00" value={sendAmount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-xmr-base border border-xmr-border p-3 text-2xl font-black text-xmr-accent focus:border-xmr-accent outline-none font-black" />
              </div>
              <button disabled={isSending || isBanned} onClick={handleSend} className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-4 font-black ${isBanned ? 'bg-red-950 text-red-500 cursor-not-allowed' : 'bg-xmr-accent text-xmr-base hover:bg-xmr-green hover:text-xmr-base'}`}><Send size={18} /> {isSending ? 'DISPATCHING...' : isBanned ? 'MISSION_ABORTED' : 'CONFIRM_DISPATCH'}</button>
            </div>
          </div>
        </div>
      )}

      {/* HEADER & TOP CONTROLS */}
      <div className="flex justify-between items-end border-b border-xmr-border/30 pb-4 relative z-10 font-black">
        <div>
           <button onClick={() => setView('home')} className="text-[10px] text-xmr-dim hover:text-xmr-green mb-1 flex items-center gap-1 cursor-pointer font-black transition-all uppercase tracking-widest">[ DASHBOARD ]</button>
           <h2 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-mono leading-none">Vault_Storage</h2>
        </div>
        <div className="flex gap-2 font-black">
          <button onClick={handleBurn} className="px-3 py-1.5 border border-red-900/50 text-red-500 text-[9px] font-black hover:bg-red-500/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><Skull size={10} /> Burn_ID</button>
          <button onClick={refresh} className="px-3 py-1.5 border border-xmr-border text-[9px] font-black hover:bg-xmr-green/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><RefreshCw size={10} className={status === StealthStep.SYNCING ? 'animate-spin' : ''} /> Sync_Ledger</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative z-10 font-black font-mono">
        {/* BALANCE CARD */}
        <Card topGradientAccentColor="xmr-green" className="lg:col-span-2 flex flex-col justify-between shadow-[0_0_30px_rgba(0,255,65,0.05)]">
          <div>
            <span className="text-[10px] text-xmr-dim uppercase font-bold tracking-[0.4em] font-black">Available_Liquidity</span>
            <div className="text-7xl font-black mt-4 text-xmr-green drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">
               {parseFloat(balance.total).toFixed(4)} <span className="text-2xl text-xmr-dim uppercase font-black">XMR</span>
            </div>
            <div className="text-xl font-black text-xmr-green/60 mt-1 uppercase tracking-[0.2em]">
               ≈ ${stats?.price.street ? (parseFloat(balance.total) * stats.price.street).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '---.--'} <span className="text-xs opacity-50">USD</span>
            </div>
          </div>
          <div className="flex gap-12 border-t border-xmr-border/20 pt-6 uppercase font-black">
            <div><span className="text-[10px] font-black text-xmr-dim uppercase">Unlocked</span><div className="text-2xl font-black text-xmr-green">{parseFloat(balance.unlocked).toFixed(4)}</div></div>
            <div><span className="text-[10px] font-black text-xmr-dim uppercase">Sync_Height</span><div className="text-2xl font-black opacity-40 text-xmr-green">{currentHeight}</div></div>
          </div>
        </Card>

        {/* PRIMARY IDENTITY CARD */}
        <div className="flex flex-col gap-6 font-black">
          <Card className="flex-grow flex flex-col justify-between">
            <div className="flex justify-between items-start font-black">
              <span className="text-[10px] text-xmr-dim uppercase font-bold tracking-widest font-black">Tactical_Identity</span>
              <button onClick={async () => { const s = await (window as any).api.getSeed(); setMnemonic(s); setShowSeedModal(true); }} className="text-xmr-green hover:text-xmr-accent transition-all cursor-pointer"><Key size={16} /></button>
            </div>
            <div className="p-3 bg-xmr-base border border-xmr-border/30 rounded-sm font-black">
              <div className="flex justify-between items-center mb-1 font-black"><span className="text-[8px] opacity-50 text-xmr-green font-black uppercase">PRIMARY_ADDRESS</span><button onClick={() => handleCopy(address)} className="text-xmr-green cursor-pointer">{copyFeedback ? <Check size={10}/> : <Copy size={10} />}</button></div>
              <code className="text-[9px] text-xmr-green break-all leading-tight block h-12 overflow-hidden italic font-black font-mono">{address}</code>
            </div>
            <div className="space-y-1.5 border-t border-xmr-border/20 pt-4 font-black">
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-xmr-green">CEX_Status:</span><span className={stats?.resistance.cex_status === 'WARNING' ? 'text-xmr-accent animate-pulse' : 'text-xmr-green'}>{stats?.resistance.cex_status || '---'}</span></div>
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-xmr-green">Privacy_Nodes:</span><span className="text-xmr-green">{stats?.resistance.privacy_nodes || '---'}</span></div>
            </div>
          </Card>
          <div className="grid grid-cols-2 gap-4 font-black">
            <button onClick={() => setShowReceiveModal(true)} className="py-4 border border-xmr-green text-xmr-green font-black uppercase text-xs tracking-widest hover:bg-xmr-green hover:text-xmr-base transition-all flex items-center justify-center gap-2 cursor-pointer"><Download size={16}/> Receive</button>
            <button onClick={() => setShowSendModal(true)} className="py-4 border border-xmr-accent text-xmr-accent font-black uppercase text-xs tracking-widest hover:bg-xmr-accent hover:text-xmr-base transition-all flex items-center justify-center gap-2 cursor-pointer"><Send size={16}/> Dispatch</button>
          </div>
        </div>
      </div>

      {/* LOWER NAVIGATION & LISTS */}
      <div className="flex gap-4 border-b border-xmr-border/20">
         <button onClick={() => setTab('ledger')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'ledger' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Identity_Ledger</button>
         <button onClick={() => setTab('addresses')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'addresses' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Managed_Addresses</button>
         <button onClick={() => setTab('contacts')} className={`px-6 py-3 text-[10px] font-black uppercase tracking-widest transition-all border-b-2 ${tab === 'contacts' ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-transparent text-xmr-dim hover:text-xmr-green'}`}>Address_Book</button>
      </div>

      <div className="min-h-[400px]">
        {/* LEDGER TAB */}
        {tab === 'ledger' && (
          <Card noPadding className="h-[400px] flex flex-col">
            <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0"><span>Transaction_History</span><span className="opacity-40">{txs?.length || 0} Records</span></div>
            <div className="flex-grow overflow-y-auto custom-scrollbar">
              {txs?.length > 0 ? (
                <table className="w-full text-left">
                   <thead className="text-[8px] text-xmr-dim border-b border-xmr-border/10 sticky top-0 bg-xmr-surface uppercase">
                      <tr><th className="px-4 py-2">Flow</th><th className="px-4 py-2">Amount</th><th className="px-4 py-2">Confirmations</th><th className="px-4 py-2 text-right">Timestamp</th></tr>
                   </thead>
                   <tbody className="text-[10px] font-black divide-y divide-xmr-border/5">
                      {txs.map((tx: any, i: number) => (
                        <tr key={i} className="hover:bg-xmr-green/5 transition-colors group">
                           <td className="px-4 py-3 flex items-center gap-2">{tx.isIncoming ? (<ArrowDownLeft size={14} className="text-xmr-green" />) : (<ArrowUpRight size={14} className="text-xmr-accent" />)} {tx.isIncoming ? 'IN' : 'OUT'}</td>
                           <td className={`px-4 py-3 ${tx.isIncoming ? 'text-xmr-green' : 'text-xmr-accent'}`}>{tx.isIncoming ? '+' : '-'}{tx.amount} XMR</td>
                           <td className="px-4 py-3 opacity-60">[{tx.confirmations || 0}]</td>
                           <td className="px-4 py-3 text-right opacity-40 text-[9px]">{new Date(tx.timestamp).toLocaleString()}</td>
                        </tr>
                      ))}
                   </tbody>
                </table>
              ) : (<div className="h-full flex items-center justify-center italic opacity-20 uppercase text-[10px]">No_Ledger_Data</div>)}
            </div>
          </Card>
        )}

        {/* ADDRESSES TAB */}
        {tab === 'addresses' && (
          <Card noPadding className="h-[400px] flex flex-col">
            <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0"><span>Internal_Subaddresses</span><span className="opacity-40">{subaddresses?.length || 0} Entries</span></div>
            <div className="flex-grow overflow-y-auto custom-scrollbar">
               <table className="w-full text-left">
                  <thead className="text-[8px] text-xmr-dim border-b border-xmr-border/10 sticky top-0 bg-xmr-surface uppercase">
                     <tr><th className="px-4 py-2">Index</th><th className="px-4 py-2">Label</th><th className="px-4 py-2">Address</th><th className="px-4 py-2 text-right">Balance</th></tr>
                  </thead>
                  <tbody className="text-[10px] font-black divide-y divide-xmr-border/5">
                     {subaddresses.map((s: any) => (
                       <tr key={s.index} className="hover:bg-xmr-green/5 transition-colors group">
                          <td className="px-4 py-3 text-xmr-dim">#{s.index}</td>
                          <td className="px-4 py-3 uppercase text-xmr-green/80">{s.label}</td>
                          <td className="px-4 py-3 font-mono opacity-60">
                             <div className="flex items-center gap-2">
                                <span className="truncate max-w-[200px]">{s.address}</span>
                                <button onClick={() => handleCopy(s.address)} className="text-xmr-green opacity-0 group-hover:opacity-100 transition-opacity"><Copy size={10}/></button>
                             </div>
                          </td>
                          <td className="px-4 py-3 text-right text-xmr-green">{parseFloat(s.balance) > 0 ? s.balance : '--'}</td>
                       </tr>
                     ))}
                  </tbody>
               </table>
            </div>
          </Card>
        )}

        {/* CONTACTS TAB */}
        {tab === 'contacts' && (
          <Card noPadding className="h-[400px] flex flex-col">
            <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0">
               <span>Address_Book</span>
               <button onClick={() => setShowAddContact(true)} className="flex items-center gap-1 text-xmr-green hover:underline cursor-pointer"><PlusCircle size={10}/> ADD_NEW</button>
            </div>
            <div className="flex-grow overflow-y-auto custom-scrollbar">
               {contacts.length > 0 ? (
                 <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-4">
                    {contacts.map((c, i) => (
                      <div key={i} className="p-4 border border-xmr-border/20 bg-xmr-green/[0.02] flex flex-col gap-3 relative group">
                         <button onClick={() => saveContacts(contacts.filter((_, idx) => idx !== i))} className="absolute top-2 right-2 text-red-900 opacity-0 group-hover:opacity-100 transition-all hover:text-red-500"><X size={12}/></button>
                         <div className="flex items-center gap-2">
                            <Book size={14} className="text-xmr-green"/>
                            <span className="text-xs font-black text-xmr-green uppercase">{c.name}</span>
                         </div>
                         <code className="text-[9px] opacity-40 break-all leading-tight italic">{c.address}</code>
                         <div className="flex gap-2">
                            <button onClick={() => handleCopy(c.address)} className="flex-1 py-1.5 border border-xmr-border/30 text-[8px] hover:bg-xmr-green/10 transition-all uppercase">Copy</button>
                            <button onClick={() => { setDestAddr(c.address); setTab('ledger'); setShowSendModal(true); }} className="flex-1 py-1.5 bg-xmr-green/10 border border-xmr-green/30 text-xmr-green text-[8px] hover:bg-xmr-green/20 transition-all uppercase">Dispatch</button>
                         </div>
                      </div>
                    ))}
                 </div>
               ) : (
                 <div className="h-full flex flex-col items-center justify-center gap-4 opacity-20">
                    <Book size={48} />
                    <span className="text-[10px] font-black uppercase">Your address book is empty</span>
                 </div>
               )}
            </div>
          </Card>
        )}
      </div>

      {/* ADD CONTACT MODAL */}
      {showAddContact && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-xmr-base/95 backdrop-blur-sm animate-in fade-in duration-200">
           <div className="w-full max-w-md space-y-6">
              <h3 className="text-xl font-black text-xmr-green uppercase italic text-center">New_Contact_Archived</h3>
              <Card className="p-6 space-y-4">
                 <div className="space-y-1">
                    <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Alias_Name</label>
                    <input type="text" value={newContact.name} onChange={(e) => setNewContact({...newContact, name: e.target.value})} placeholder="Tactical_Alias" className="w-full bg-xmr-base border border-xmr-border p-3 text-[11px] text-xmr-green outline-none" />
                 </div>
                 <div className="space-y-1">
                    <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Monero_Address</label>
                    <input type="text" value={newContact.address} onChange={(e) => setNewContact({...newContact, address: e.target.value})} placeholder="4... / 8..." className="w-full bg-xmr-base border border-xmr-border p-3 text-[11px] text-xmr-green outline-none" />
                 </div>
                 <div className="flex gap-3">
                    <button onClick={() => setShowAddContact(false)} className="flex-1 py-3 border border-xmr-border text-xmr-dim text-[10px] font-black uppercase">Cancel</button>
                    <button onClick={() => { saveContacts([...contacts, newContact]); setNewContact({name:'', address:''}); setShowAddContact(false); }} className="flex-[2] py-3 bg-xmr-green text-xmr-base text-[10px] font-black uppercase">Save_Contact</button>
                 </div>
              </Card>
           </div>
        </div>
      )}
    </div>
  );
}
