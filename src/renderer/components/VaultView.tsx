import React, { useState, useEffect } from 'react';
import { Skull, RefreshCw, Copy, Check, Key, ShieldAlert, Send, ArrowDownLeft, ArrowUpRight, X, Download, PlusCircle } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { StealthStep } from '../services/stealth/types';
import { useStats } from '../hooks/useStats';

interface VaultViewProps {
  setView: (v: any) => void;
  vault: any; 
  handleBurn: () => void;
}

export function VaultView({ setView, vault, handleBurn }: VaultViewProps) {
  const { balance, address, logs, refresh, status, isSending, sendXmr, createSubaddress, txs, isStagenet, syncPercent, currentHeight } = vault;
  const { stats } = useStats();
  
  // Modals
  const [showSeedModal, setShowSeedModal] = useState(false);
  const [showReceiveModal, setShowReceiveModal] = useState(false);
  const [showSendModal, setShowSendModal] = useState(false);
  
  // Identity State
  const [mnemonic, setMnemonic] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  
  // Send State
  const [destAddr, setDestAddr] = useState('');
  const [sendAmount, setAmount] = useState('');
  const [isBanned, setIsBanned] = useState(false);

  // Formatting
  const xmrDisplay = parseFloat(balance.total).toFixed(4);
  const unlockedDisplay = parseFloat(balance.unlocked).toFixed(4);
  const pendingDisplay = (parseFloat(balance.total) - parseFloat(balance.unlocked)).toFixed(4);
  const fiatValue = stats?.price.street ? (parseFloat(balance.total) * parseFloat(stats.price.street)).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '---.--';

  const handleCopy = () => {
    navigator.clipboard.writeText(address);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleOpenBackup = async () => {
    const seed = await (window as any).api.getSeed();
    setMnemonic(seed || 'SEED_NOT_FOUND');
    setShowSeedModal(true);
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

  // Sentinel check logic
  useEffect(() => {
    if (destAddr.length > 30) {
      fetch(`https://api.kyc.rip/v1/tools/ban-list?address=${destAddr}`)
        .then(res => res.json())
        .then(data => setIsBanned(data.results && data.results.length > 0))
        .catch(() => setIsBanned(false));
    } else setIsBanned(false);
  }, [destAddr]);

  return (
    <div className="max-w-6xl mx-auto space-y-6 py-2 animate-in fade-in zoom-in-95 duration-300 font-black relative">
      {/* 1. SEED MODAL */}
      {showSeedModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md animate-in fade-in duration-300">
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

      {/* 2. RECEIVE MODAL */}
      {showReceiveModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
          <div className="w-full max-w-md bg-black border border-[#004d13] p-8 space-y-8 relative font-black">
            <button onClick={() => setShowReceiveModal(false)} className="absolute top-4 right-4 text-xmr-dim hover:text-white font-black"><X size={24} /></button>
            <div className="text-center space-y-2 font-black">
              <h3 className="text-2xl font-black italic uppercase text-[#00ff41]">Inbound_Uplink</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">Scan to receive funds directly</p>
            </div>
            <div className="flex flex-col items-center gap-6 font-black">
              <div className="p-3 bg-white rounded-lg border-2 border-[#00ff41]/40"><QRCodeSVG value={address} size={180} bgColor="#ffffff" fgColor="#000000" level="M" /></div>
              <div className="w-full p-3 bg-[#00ff41]/5 border border-[#00ff41]/20 rounded-sm font-black">
                <div className="flex justify-between items-center mb-1 font-black"><span className="text-[8px] opacity-50 text-white uppercase font-black">Current_Address</span><button onClick={handleCopy} className="text-[#00ff41]">{copyFeedback ? <Check size={10}/> : <Copy size={10} />}</button></div>
                <code className="text-[10px] text-white break-all leading-tight italic font-mono font-black">{address}</code>
              </div>
              <button onClick={createSubaddress} className="text-[10px] text-[#00ff41] font-black underline uppercase hover:text-white transition-all font-mono tracking-widest flex items-center gap-2 font-black"><PlusCircle size={12}/> Generate_New_Subaddress</button>
            </div>
          </div>
        </div>
      )}

      {/* 3. SEND MODAL */}
      {showSendModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
          <div className="w-full max-w-lg bg-black border border-[#ff6600]/50 p-8 space-y-6 relative font-black">
            <button onClick={() => setShowSendModal(false)} className="absolute top-4 right-4 text-xmr-dim hover:text-white"><X size={24} /></button>
            <div className="text-center space-y-2 mb-4 font-black">
              <h3 className="text-2xl font-black italic uppercase text-[#ff6600]">Dispatch_Sequence</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">Constructing outbound transaction</p>
            </div>
            <div className="space-y-4 font-black">
              <div className="space-y-1 font-black"><div className="flex justify-between items-center font-black"><label className="text-[9px] font-black text-xmr-dim uppercase font-black">Destination_Address</label>{isBanned && <span className="text-[8px] text-red-500 font-black animate-pulse uppercase tracking-tighter">Intercepted</span>}</div><input type="text" placeholder="4... / 8..." value={destAddr} onChange={(e) => setDestAddr(e.target.value)} className={`w-full bg-black border p-3 text-[10px] text-white focus:border-[#ff6600] outline-none font-black transition-colors ${isBanned ? 'border-red-600' : 'border-[#004d13]'}`} /></div>
              <div className="space-y-1 font-black"><label className="text-[9px] font-black text-xmr-dim uppercase font-black">Amount (XMR)</label><input type="number" placeholder="0.00" value={sendAmount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-black border border-[#004d13] p-3 text-2xl font-black text-[#ff6600] focus:border-[#ff6600] outline-none font-black" /></div>
              <button disabled={isSending || isBanned} onClick={handleSend} className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-4 font-black ${isBanned ? 'bg-red-950 text-red-500 cursor-not-allowed' : 'bg-[#ff6600] text-black hover:bg-white'}`}><Send size={18} /> {isSending ? 'DISPATCHING...' : isBanned ? 'MISSION_ABORTED' : 'CONFIRM_DISPATCH'}</button>
            </div>
          </div>
        </div>
      )}

      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.02] pointer-events-none select-none -z-10">
        <img src="/monero-xmr-logo.png" className="w-[600px] grayscale brightness-200" alt="Decoration" />
      </div>

      {/* 4. MAIN INTERFACE */}
      <div className="flex justify-between items-end border-b border-[#004d13]/30 pb-4 relative z-10 font-black">
        <div><button onClick={() => setView('home')} className="text-[10px] text-xmr-dim hover:text-[#00ff41] mb-1 flex items-center gap-1 cursor-pointer font-black">[ DASHBOARD ]</button><h2 className="text-3xl font-black italic uppercase tracking-tighter text-white font-mono leading-none">Vault_Storage</h2></div>
        <div className="flex gap-2 font-black">
          <button onClick={handleBurn} className="px-3 py-1.5 border border-red-900/50 text-red-500 text-[9px] font-black hover:bg-red-500/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><Skull size={10} /> Burn_ID</button>
          <button onClick={refresh} className="px-3 py-1.5 border border-[#004d13] text-[9px] font-black hover:bg-[#00ff41]/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><RefreshCw size={10} className={status === StealthStep.SYNCING ? 'animate-spin' : ''} /> Sync_Ledger</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 relative z-10 font-black font-mono">
        {/* BIG BALANCE CARD */}
        <div className="lg:col-span-2 p-8 border border-[#004d13] bg-[#00ff41]/5 rounded-sm flex flex-col justify-between h-fit shadow-[0_0_30px_rgba(0,255,65,0.05)]">
          <div>
            <span className="text-[10px] text-xmr-dim uppercase font-bold tracking-[0.4em] font-black">Available_Liquidity</span>
            <div className="text-7xl font-black mt-4 text-white drop-shadow-[0_0_15px_rgba(255,255,255,0.1)]">{xmrDisplay} <span className="text-2xl text-xmr-dim uppercase font-black">XMR</span></div>
            <div className="text-xl font-black text-[#00ff41]/60 mt-1 uppercase tracking-[0.2em]">≈ ${fiatValue} <span className="text-xs opacity-50">USD</span></div>
          </div>
          <div className="flex gap-12 border-t border-[#004d13]/20 pt-6 uppercase font-black">
            <div><span className="text-[10px] font-black text-xmr-dim uppercase">Unlocked_Assets</span><div className="text-2xl font-black text-white">{unlockedDisplay}</div></div>
            <div><span className="text-[10px] font-black text-xmr-dim uppercase">Pending_Lock</span><div className="text-2xl font-black opacity-20 text-white">{pendingDisplay}</div></div>
          </div>
        </div>

        <div className="flex flex-col gap-6 font-black">
          <div className="p-6 border border-[#004d13] bg-black/40 space-y-6 flex-grow flex flex-col justify-between font-black">
            <div className="flex justify-between items-start font-black">
              <span className="text-[10px] text-xmr-dim uppercase font-bold tracking-widest font-black">Tactical_Identity</span>
              <button onClick={handleOpenBackup} className="text-[#00ff41] hover:text-white transition-all cursor-pointer"><Key size={16} /></button>
            </div>
            <div className="p-3 bg-black border border-[#004d13]/30 rounded-sm font-black">
              <div className="flex justify-between items-center mb-1 font-black"><span className="text-[8px] opacity-50 text-white font-black uppercase">PRIMARY_ADDRESS</span><button onClick={handleCopy} className="text-[#00ff41] cursor-pointer">{copyFeedback ? <Check size={10}/> : <Copy size={10} />}</button></div>
              <code className="text-[9px] text-white break-all leading-tight block h-12 overflow-hidden italic font-black font-mono">{address}</code>
            </div>
            
            <div className="space-y-1.5 border-t border-[#004d13]/20 pt-4 font-black">
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-white">CEX_Status:</span><span className={stats?.resistance.cex_status === 'WARNING' ? 'text-orange-500 animate-pulse' : 'text-[#00ff41]'}>{stats?.resistance.cex_status || '---'}</span></div>
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-white">Privacy_Nodes:</span><span className="text-white">{stats?.resistance.privacy_nodes || '---'} <span className="opacity-30 text-[7px]">({stats?.resistance.privacy_percentage || '--'}%)</span></span></div>
              <div className="flex justify-between text-[9px] uppercase font-black"><span className="opacity-40 text-white">Sync_Height:</span><span className="text-[#00ff41] font-black">{currentHeight || '...'}</span></div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 font-black">
            <button onClick={() => setShowReceiveModal(true)} className="py-4 border border-[#00ff41] text-[#00ff41] font-black uppercase text-xs tracking-widest hover:bg-[#00ff41] hover:text-black transition-all flex items-center justify-center gap-2 cursor-pointer font-black font-black"><Download size={16}/> Receive</button>
            <button onClick={() => setShowSendModal(true)} className="py-4 border border-[#ff6600] text-[#ff6600] font-black uppercase text-xs tracking-widest hover:bg-[#ff6600] hover:text-black transition-all flex items-center justify-center gap-2 cursor-pointer font-black font-black"><Send size={16}/> Dispatch</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 relative z-10 font-black font-mono">
        <div className="flex flex-col border border-[#004d13] bg-black/20 rounded-sm h-[300px] font-black">
          <div className="px-4 py-3 border-b border-[#004d13]/20 bg-black/40 text-[10px] font-black uppercase tracking-widest flex justify-between items-center shrink-0 font-black"><span>Identity_Ledger</span><span className="text-[8px] opacity-40 uppercase font-black">{txs?.length || 0} Records</span></div>
          <div className="flex-grow overflow-y-auto font-black">
            {txs?.length > 0 ? (<div className="divide-y divide-[#004d13]/10 font-black">{txs.map((tx: any, i: number) => (<div key={i} className="p-3 hover:bg-[#00ff41]/5 transition-colors group font-black"><div className="flex justify-between mb-1 font-black"><div className="flex items-center gap-2 font-black">{tx.isIncoming ? (<ArrowDownLeft size={14} className="text-[#00ff41]" />) : (<ArrowUpRight size={14} className="text-[#ff6600]" />)}<span className={`text-sm ${tx.isIncoming ? 'text-[#00ff41]' : 'text-[#ff6600]'} font-black`}>{tx.isIncoming ? '+' : '-'}{tx.amount} XMR</span></div><span className="opacity-30 text-[9px] font-black">{new Date(tx.timestamp).toLocaleString()}</span></div></div>))}</div>) : (<div className="h-full flex items-center justify-center italic opacity-20 uppercase text-[10px] font-black">No_Ledger_Data</div>)}
          </div>
        </div>
        <div className="flex flex-col border border-[#004d13] bg-black/20 rounded-sm h-[300px] font-black">
          <div className="px-4 py-3 border-b border-[#004d13]/20 bg-black/40 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0 font-black"><span>System_Daemon</span><span className="text-[8px] animate-pulse font-black">● LIVE</span></div>
          <div className="p-4 font-mono text-[9px] text-xmr-dim space-y-1 overflow-y-auto font-black">{logs.map((log: string, i: number) => (<p key={i} className={i === 0 ? 'text-[#00ff41]' : 'opacity-60 font-black'}>{'>'} {log}</p>))}</div>
        </div>
      </div>
    </div>
  );
}
