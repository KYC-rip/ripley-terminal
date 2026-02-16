import React, { useState, useEffect } from 'react';
import { Skull, RefreshCw, Copy, Check, EyeOff, Key, ShieldAlert, Download, Send, ShieldAlert as InterceptIcon, ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { StealthStep } from '../services/stealth/types';

interface VaultViewProps {
  setView: (v: any) => void;
  vault: any; // From useVault
  handleBurn: () => void;
}

export function VaultView({ setView, vault, handleBurn }: VaultViewProps) {
  const { balance, address, logs, refresh, status, isSending, sendXmr, createSubaddress, txs, isStagenet } = vault;
  const [activeTab, setActiveTab] = useState<'receive' | 'send'>('receive');
  const [showSeed, setShowSeed] = useState(false);
  const [mnemonic, setMnemonic] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  
  const [destAddr, setDestAddr] = useState('');
  const [sendAmount, setAmount] = useState('');
  const [isBanned, setIsBanned] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(address);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleShowSeed = async () => {
    if (showSeed) { setShowSeed(false); return; }
    const seed = await (window as any).api.getSeed();
    setMnemonic(seed || 'SEED_NOT_FOUND');
    setShowSeed(true);
  };

  const handleSend = async () => {
    if (!destAddr || !sendAmount) return;
    try {
      await sendXmr(destAddr, parseFloat(sendAmount));
      setDestAddr(''); setAmount('');
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
    <div className="max-w-5xl mx-auto space-y-6 py-4 animate-in fade-in zoom-in-95 duration-300 font-black relative">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.03] pointer-events-none select-none -z-10">
        <img src="/monero-xmr-logo.png" className="w-[600px] grayscale brightness-200" alt="Decoration" />
      </div>

      <div className="flex justify-between items-end border-b border-[#004d13]/30 pb-4 relative z-10">
        <div>
          <button onClick={() => setView('home')} className="text-[10px] text-xmr-dim hover:text-[#00ff41] mb-1 flex items-center gap-1 cursor-pointer font-black">[ DASHBOARD ]</button>
          <h2 className="text-2xl font-black italic uppercase tracking-tighter text-white font-mono">Vault_Storage</h2>
        </div>
        <div className="flex gap-2">
          <button onClick={handleBurn} className="px-3 py-1.5 border border-red-900/50 text-red-500 text-[9px] font-black hover:bg-red-500/10 transition-all flex items-center gap-2 cursor-pointer uppercase"><Skull size={10} /> Burn_ID</button>
          <button onClick={refresh} className="px-3 py-1.5 border border-[#004d13] text-[9px] font-black hover:bg-[#00ff41]/10 transition-all flex items-center gap-2 cursor-pointer uppercase"><RefreshCw size={10} className={status === StealthStep.SYNCING ? 'animate-spin' : ''} /> Sync_Ledger</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-mono relative z-10">
        <div className="lg:col-span-2 p-6 border border-[#004d13] bg-[#00ff41]/5 rounded-sm flex flex-col justify-between h-56">
          <div><span className="text-[9px] text-xmr-dim uppercase font-bold tracking-[0.2em]">Liquidity</span><div className="text-5xl font-black mt-2 flex items-baseline gap-3 text-white">{balance.total} <span className="text-xl text-xmr-dim uppercase text-white font-black">XMR</span></div></div>
          <div className="mt-6 flex gap-8 border-t border-[#004d13]/20 pt-4 text-xmr-dim">
            <div><span className="text-[8px] uppercase font-bold">Unlocked</span><div className="text-lg font-black text-white">{balance.unlocked}</div></div>
            <div><span className="text-[8px] uppercase font-bold">Pending</span><div className="text-lg font-black opacity-30 text-white">{(Number(balance.total) - Number(balance.unlocked)).toFixed(4)}</div></div>
          </div>
        </div>
        <div className="space-y-6">
          <div className="p-5 border border-[#004d13] bg-black/40 space-y-4">
            <span className="text-[9px] text-xmr-dim uppercase font-bold">Identity_Header</span>
            <div className="p-3 bg-black border border-[#004d13]/30 rounded-sm">
              <div className="flex justify-between items-center mb-1"><span className="text-[8px] opacity-50 text-white font-black">PRIMARY_ADDR</span><button onClick={handleCopy} className="text-[#00ff41] cursor-pointer transition-all">{copyFeedback ? <Check size={10}/> : <Copy size={10} />}</button></div>
              <code className="text-[9px] text-white break-all leading-tight block italic">{address}</code>
            </div>
            <div className="space-y-1 font-black"><div className="flex justify-between text-[9px] uppercase"><span className="opacity-40 tracking-tighter text-white">Engine:</span><span className="text-[#00ff41]">WASM_Runtime</span></div><div className="flex justify-between text-[9px] uppercase"><span className="opacity-40 tracking-tighter text-white">Network:</span><span className={isStagenet ? "text-orange-500" : "text-[#00ff41]"}>{isStagenet ? 'STAGENET' : 'MAINNET'}</span></div></div>
          </div>

          <div className={`p-5 border transition-all duration-500 ${showSeed ? 'bg-white text-black border-white' : 'bg-black/40 border-[#004d13] text-xmr-dim'}`}>
            <div className="flex justify-between items-center mb-3">
              <span className="text-[9px] font-black uppercase">Master_Seed_Phrase</span>
              <button onClick={handleShowSeed} className={`p-1 rounded-sm transition-all ${showSeed ? 'bg-black text-white' : 'text-[#00ff41] hover:bg-[#00ff41]/10'}`}>
                {showSeed ? <EyeOff size={14} /> : <Key size={14} />}
              </button>
            </div>
            {showSeed ? (
              <div className="space-y-3">
                <p className="text-[10px] leading-relaxed font-black break-words bg-black/5 p-3 rounded-sm select-text font-black">{mnemonic}</p>
                <div className="flex items-center gap-2 text-[8px] font-black text-red-600 animate-pulse uppercase"><ShieldAlert size={10} /> NEVER_SHARE_THIS_PHRASE</div>
              </div>
            ) : (
              <div className="py-4 text-center"><span className="text-[8px] font-black opacity-30 uppercase tracking-[0.2em]">Data_Encrypted</span></div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 relative z-10 font-black">
        <div className="border border-[#004d13] bg-black/20 rounded-sm flex flex-col">
          <div className="flex border-b border-[#004d13]/30">
            <button onClick={() => setActiveTab('receive')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'receive' ? 'bg-[#004d13]/30 text-[#00ff41]' : 'opacity-40 hover:opacity-100'}`}>[ Receive ]</button>
            <button onClick={() => setActiveTab('send')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'send' ? 'bg-[#004d13]/30 text-[#00ff41]' : 'opacity-40 hover:opacity-100'}`}>[ Dispatch ]</button>
          </div>
          <div className="p-6 flex-grow min-h-[300px]">
            {activeTab === 'receive' ? (
              <div className="space-y-6 flex flex-col items-center justify-center h-full text-center">
                <div className="p-3 bg-white rounded-lg border-2 border-[#00ff41]/20 relative group"><QRCodeSVG value={address} size={140} bgColor="#ffffff" fgColor="#000000" level="M" /></div>
                <div className="space-y-2 font-black"><p className="text-[10px] uppercase text-xmr-dim max-w-[200px]">Funds sent here stay invisible.</p><button onClick={createSubaddress} className="text-[10px] text-[#00ff41] underline cursor-pointer uppercase transition-all font-black">Generate_Subaddress</button></div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1"><div className="flex justify-between items-center"><label className="text-[9px] font-black text-xmr-dim uppercase">Target_Addr</label>{isBanned && <span className="text-[8px] text-red-500 font-bold animate-pulse flex items-center gap-1 uppercase tracking-tighter">Intercepted</span>}</div><input type="text" placeholder="4... / 8..." value={destAddr} onChange={(e) => setDestAddr(e.target.value)} className={`w-full bg-black border p-3 text-[10px] text-white focus:border-[#00ff41] outline-none transition-colors font-black ${isBanned ? 'border-red-600' : 'border-[#004d13]'}`} /></div>
                <div className="space-y-1"><label className="text-[9px] font-black text-xmr-dim uppercase tracking-tighter font-black">Amount (XMR)</label><div className="relative"><input type="number" placeholder="0.00" value={sendAmount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-black border border-[#004d13] p-3 text-lg font-black text-[#00ff41] focus:border-[#00ff41] outline-none" /><button className="absolute right-3 top-3 text-[9px] font-black text-xmr-dim hover:text-white uppercase cursor-pointer font-mono font-black">[ MAX ]</button></div></div>
                <button disabled={isSending || isBanned} onClick={handleSend} className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-4 ${isBanned ? 'bg-red-950 text-red-500 cursor-not-allowed border border-red-600' : 'bg-[#00ff41] text-black hover:bg-white'}`}><Send size={16} /> {isSending ? 'DISPATCHING...' : isBanned ? 'MISSION_ABORTED' : 'CONFIRM_DISPATCH'}</button>
              </div>
            )}
          </div>
        </div>
        <div className="border border-[#004d13] bg-black/20 rounded-sm overflow-hidden flex flex-col h-[350px]">
          <div className="px-4 py-3 border-b border-[#004d13]/20 bg-black/40 text-[9px] font-black uppercase tracking-widest flex justify-between items-center"><span>Identity_Ledger</span><span className="text-[8px] opacity-40 uppercase font-black">{txs?.length || 0} Records</span></div>
          <div className="flex-grow overflow-y-auto font-mono text-[9px]">{txs?.length > 0 ? (<div className="divide-y divide-[#004d13]/10">{txs.map((tx: any, i: number) => (<div key={i} className="p-3 hover:bg-[#00ff41]/5 transition-colors group"><div className="flex justify-between mb-1"><div className="flex items-center gap-2">{tx.isIncoming ? (<ArrowDownLeft size={12} className="text-[#00ff41]" />) : (<ArrowUpRight size={12} className="text-[#ff6600]" />)}<span className={`font-black ${tx.isIncoming ? 'text-[#00ff41]' : 'text-[#ff6600]'}`}>{tx.isIncoming ? '+' : '-'}{tx.amount} XMR</span></div><span className="opacity-30 group-hover:opacity-60 transition-opacity">{new Date(tx.timestamp).toLocaleString()}</span></div><div className="flex justify-between items-center"><code className="opacity-20 group-hover:opacity-40 transition-opacity truncate max-w-[180px]">{tx.id}</code><span className={`text-[8px] font-black px-1.5 py-0.5 rounded-xs ${tx.confirmations >= 10 ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'bg-white/5 text-white/40'}`}>{tx.confirmations >= 10 ? 'CONFIRMED' : `PENDING (${tx.confirmations}/10)`}</span></div></div>))}</div>) : (<div className="h-full flex items-center justify-center italic opacity-20 uppercase tracking-widest font-black">No_Records_Logged</div>)}</div>
        </div>
      </div>
    </div>
  );
}
