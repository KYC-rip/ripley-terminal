import { useState, useEffect } from 'react';
import { Shield, Zap, Lock, Ghost, Database, RefreshCw, Send, Copy, Check, ShieldAlert, Skull, Settings, ArrowUpRight, ArrowDownLeft, Key, EyeOff } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useVault } from './hooks/useVault';
import { SwapView } from './components/SwapView';
import { SettingsView } from './components/SettingsView';
import { TorProvider, useTor } from './contexts/TorContext';
import { StealthStep } from './services/stealth/types';

function MainApp() {
  const [view, setView] = useState<'home' | 'vault' | 'swap' | 'settings'>('home');
  const [activeTab, setActiveTab] = useState<'receive' | 'send'>('receive');
  const { balance, address, logs, refresh, status, isInitializing, isSending, sendXmr, createSubaddress, syncPercent, txs, isStagenet } = useVault();
  const { useTor: torEnabled, setUseTor } = useTor();
  
  // Settings & UI State
  const [showScanlines, setShowScanlines] = useState(true);
  const [showSeed, setShowSeed] = useState(false);
  const [mnemonic, setMnemonic] = useState('');

  // Load UI specific settings
  useEffect(() => {
    (window as any).api.getConfig('show_scanlines').then((v: boolean) => {
      if (v !== undefined) setShowScanlines(v);
    });
  }, [view]);

  // Send State
  const [destAddr, setDestAddr] = useState('');
  const [sendAmount, setAmount] = useState('');
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [isBanned, setIsBanned] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(address);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  const handleShowSeed = async () => {
    if (showSeed) {
      setShowSeed(false);
      return;
    }
    const seed = await (window as any).api.getSeed();
    setMnemonic(seed || 'SEED_NOT_FOUND');
    setShowSeed(true);
  };

  const handleBurn = async () => {
    if (confirm("🚨 WARNING: Erase local identity?")) {
      await (window as any).api.burnIdentity();
      location.reload();
    }
  };

  // Sentinel Check
  useEffect(() => {
    if (destAddr.length > 30) {
      const checkBan = async () => {
        try {
          const res = await fetch(`https://api.kyc.rip/v1/tools/ban-list?address=${destAddr}`);
          const data = await res.json();
          if (data.results && data.results.length > 0) setIsBanned(true);
          else setIsBanned(false);
        } catch (e) {}
      };
      checkBan();
    } else setIsBanned(false);
  }, [destAddr]);

  const handleSend = async () => {
    if (!destAddr || !sendAmount) return;
    try {
      await sendXmr(destAddr, parseFloat(sendAmount));
      setDestAddr(''); setAmount('');
      alert("SUCCESS: BROADCASTED.");
    } catch (e: any) { alert(`FAIL: ${e.message}`); }
  };

  if (isInitializing) {
    const displayPercent = Math.max(syncPercent, 0);
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#050505] text-[#00ff41] font-mono p-10 relative">
        <style>{`
          @keyframes progress-indeterminate { 0% { transform: translateX(-100%) scaleX(0.2); } 50% { transform: translateX(0%) scaleX(0.5); } 100% { transform: translateX(100%) scaleX(0.2); } }
          .scanline-overlay { background: linear-gradient(to bottom, transparent 50%, rgba(0, 77, 19, 0.1) 50%); background-size: 100% 4px; pointer-events: none; z-index: 100; }
        `}</style>
        <div className="fixed inset-0 scanline-overlay pointer-events-none z-50"></div>
        
        {/* Rescue Settings Entry */}
        <div className="absolute top-6 right-6 z-[60]">
          <button 
            onClick={() => setView('settings')}
            className="flex items-center gap-2 px-3 py-1.5 border border-[#004d13] text-[9px] font-black text-xmr-dim hover:text-[#00ff41] hover:border-[#00ff41] transition-all cursor-pointer uppercase"
          >
            <Settings size={12} /> Rescue_Config
          </button>
        </div>

        {view === 'settings' ? (
          <div className="w-full max-w-4xl z-[60] bg-[#050505] p-4 border border-[#004d13] shadow-[0_0_50px_rgba(0,255,65,0.1)]">
            <div className="flex justify-between items-center mb-6 border-b border-[#004d13]/30 pb-4">
               <span className="text-[10px] font-black text-white uppercase">[ EMERGENCY_OVERRIDE_ACTIVE ]</span>
               <button onClick={() => location.reload()} className="text-[9px] font-black text-[#00ff41] hover:underline uppercase tracking-widest cursor-pointer">[ Restart_Uplink ]</button>
            </div>
            <SettingsView />
          </div>
        ) : (
          <>
            <Shield size={48} className="animate-pulse mb-6 text-white" />
            <div className="flex flex-col items-center gap-3 w-full max-w-xs">
              <div className="flex justify-between w-full text-[10px] font-black uppercase tracking-widest text-white">
                <span>Uplink_Sequence</span>
                <span>{displayPercent > 0 ? `${displayPercent.toFixed(1)}%` : 'Active'}</span>
              </div>
              <div className="w-full h-1 bg-[#004d13] rounded-full overflow-hidden relative border border-[#00ff41]/20">
                {displayPercent > 0 ? (
                  <div className="h-full bg-[#00ff41] transition-all duration-500" style={{ width: `${displayPercent}%` }}></div>
                ) : (
                  <div className="absolute inset-0 bg-[#00ff41] animate-[progress-indeterminate_2s_infinite_linear]"></div>
                )}
              </div>
            </div>
            <div className="mt-12 w-full max-w-sm border-l border-[#00ff41]/20 pl-4">
               <div className="text-[8px] text-[#00661a] space-y-1 font-bold">
                  {logs.slice(0, 6).map((l, i) => (<p key={i} className={`truncate ${i === 0 ? 'text-[#00ff41]' : 'opacity-60'}`}>{'>'} {l}</p>))}
               </div>
            </div>
          </>
        )}
      </div>
    );
  }

  const renderHome = () => (
    <div className="max-w-4xl mx-auto space-y-12 py-10 animate-in slide-in-from-bottom-4 duration-500 font-black">
      <section className="space-y-6 pt-10 border-l-2 border-[#00ff41]/20 pl-8 font-black">
        <div className="space-y-2">
          <h1 className="text-6xl font-black tracking-tighter italic uppercase leading-none text-white font-mono">Sovereign <br/> Vault_Portal</h1>
          <div className="h-1 w-32 bg-[#00ff41]"></div>
        </div>
        <p className="text-[10px] opacity-60 max-w-md leading-relaxed uppercase tracking-[0.2em]">Authorized Local Instance. Hardware-agnostic encryption layer active.</p>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-6 font-mono font-black">
        <div onClick={() => setView('vault')} className="p-6 border border-[#004d13] bg-black/40 rounded-sm hover:border-[#00ff41] hover:bg-[#00ff41]/5 transition-all cursor-pointer group">
          <Lock size={24} className="mb-4 text-[#00ff41]" />
          <h3 className="text-lg font-bold mb-2 uppercase">Enter_Vault</h3>
          <p className="text-[9px] opacity-40 uppercase leading-loose text-xmr-dim">Ledger analysis and signing operations.</p>
          <div className="mt-8 flex justify-between items-center text-[10px]"><span>UNLOCKED</span><span>[ OPEN ]</span></div>
        </div>
        <div onClick={() => setView('swap')} className="p-6 border border-[#004d13] bg-black/40 rounded-sm hover:border-[#ff6600] hover:bg-[#ff6600]/5 transition-all cursor-pointer group">
          <Ghost size={24} className="mb-4 text-[#ff6600]" />
          <h3 className="text-lg font-bold mb-2 uppercase text-[#ff6600]">Ghost_Swap</h3>
          <p className="text-[9px] opacity-40 uppercase leading-loose text-xmr-dim">Direct darknet asset bridging.</p>
          <div className="mt-8 flex justify-between items-center text-[10px] text-[#ff6600]"><span>ROUTING</span><span>[ INIT ]</span></div>
        </div>
        <div onClick={() => setView('settings')} className="p-6 border border-[#004d13] bg-black/40 rounded-sm hover:border-white hover:bg-white/5 transition-all cursor-pointer group">
          <Settings size={24} className="mb-4 text-white opacity-70" />
          <h3 className="text-lg font-bold mb-2 uppercase text-white opacity-70">Terminal_Config</h3>
          <p className="text-[9px] opacity-40 uppercase leading-loose text-xmr-dim">Uplink protocols and countermeasures.</p>
          <div className="mt-8 flex justify-between items-center text-[10px] text-white"><span>CENTER</span><span>[ CONFIGURE ]</span></div>
        </div>
      </div>
    </div>
  );

  const renderVault = () => (
    <div className="max-w-5xl mx-auto space-y-6 py-4 animate-in fade-in zoom-in-95 duration-300 font-black relative">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 opacity-[0.03] pointer-events-none select-none -z-10">
        <img src="/monero-xmr-logo.png" className="w-[600px] grayscale brightness-200" alt="Decoration" />
      </div>

      <div className="flex justify-between items-end border-b border-[#004d13]/30 pb-4 relative z-10">
        <div><button onClick={() => setView('home')} className="text-[10px] text-xmr-dim hover:text-[#00ff41] mb-1 flex items-center gap-1 cursor-pointer font-black">[ DASHBOARD ]</button><h2 className="text-2xl font-black italic uppercase tracking-tighter text-white font-mono">Vault_Storage</h2></div>
        <div className="flex gap-2">
          <button onClick={handleBurn} className="px-3 py-1.5 border border-red-900/50 text-red-500 text-[9px] font-black hover:bg-red-500/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><Skull size={10} /> Burn_ID</button>
          <button onClick={refresh} className="px-3 py-1.5 border border-[#004d13] text-[9px] font-black hover:bg-[#00ff41]/10 transition-all flex items-center gap-2 cursor-pointer uppercase font-black"><RefreshCw size={10} className={status === StealthStep.SYNCING ? 'animate-spin' : ''} /> Sync_Ledger</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 font-mono relative z-10">
        <div className="lg:col-span-2 p-6 border border-[#004d13] bg-[#00ff41]/5 rounded-sm flex flex-col justify-between h-56">
          <div><span className="text-[9px] text-xmr-dim uppercase font-bold tracking-[0.2em]">Liquidity</span><div className="text-5xl font-black mt-2 flex items-baseline gap-3 text-white font-black">{balance.total} <span className="text-xl text-xmr-dim uppercase text-white">XMR</span></div></div>
          <div className="mt-6 flex gap-8 border-t border-[#004d13]/20 pt-4 text-xmr-dim">
            <div><span className="text-[8px] uppercase font-bold">Unlocked</span><div className="text-lg font-black text-white">{balance.unlocked}</div></div>
            <div><span className="text-[8px] uppercase font-bold">Pending</span><div className="text-lg font-black opacity-30 text-white">{(Number(balance.total) - Number(balance.unlocked)).toFixed(4)}</div></div>
          </div>
        </div>
        <div className="space-y-6">
          <div className="p-5 border border-[#004d13] bg-black/40 space-y-4">
            <span className="text-[9px] text-xmr-dim uppercase font-bold">Identity_Header</span>
            <div className="p-3 bg-black border border-[#004d13]/30 rounded-sm">
              <div className="flex justify-between items-center mb-1"><span className="text-[8px] opacity-50 text-white font-black uppercase">PRIMARY_ADDR</span><button onClick={handleCopy} className="text-[#00ff41] cursor-pointer transition-all">{copyFeedback ? <Check size={10}/> : <Copy size={10} />}</button></div>
              <code className="text-[9px] text-white break-all leading-tight block italic font-mono">{address}</code>
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
                <p className="text-[10px] leading-relaxed font-black break-words bg-black/5 p-3 rounded-sm select-text">{mnemonic}</p>
                <div className="flex items-center gap-2 text-[8px] font-black text-red-600 animate-pulse uppercase"><ShieldAlert size={10} /> NEVER_SHARE_THIS_PHRASE</div>
              </div>
            ) : (
              <div className="py-4 text-center"><span className="text-[8px] font-black opacity-30 uppercase tracking-[0.2em]">Data_Encrypted</span></div>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 relative z-10">
        <div className="border border-[#004d13] bg-black/20 rounded-sm flex flex-col">
          <div className="flex border-b border-[#004d13]/30">
            <button onClick={() => setActiveTab('receive')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'receive' ? 'bg-[#004d13]/30 text-[#00ff41]' : 'opacity-40 hover:opacity-100'}`}>[ Receive ]</button>
            <button onClick={() => setActiveTab('send')} className={`flex-1 py-3 text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'send' ? 'bg-[#004d13]/30 text-[#00ff41]' : 'opacity-40 hover:opacity-100'}`}>[ Dispatch ]</button>
          </div>
          <div className="p-6 flex-grow min-h-[300px]">
            {activeTab === 'receive' ? (
              <div className="space-y-6 flex flex-col items-center justify-center h-full text-center">
                <div className="p-3 bg-white rounded-lg border-2 border-[#00ff41]/20 relative group"><QRCodeSVG value={address} size={140} bgColor="#ffffff" fgColor="#000000" level="M" /></div>
                <div className="space-y-2 font-black"><p className="text-[10px] uppercase text-xmr-dim max-w-[200px]">Funds sent here stay invisible.</p><button onClick={createSubaddress} className="text-[10px] text-[#00ff41] underline cursor-pointer uppercase transition-all">Generate_Subaddress</button></div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1"><div className="flex justify-between items-center"><label className="text-[9px] font-black text-xmr-dim uppercase">Target_Addr</label>{isBanned && <span className="text-[8px] text-red-500 font-bold animate-pulse flex items-center gap-1 uppercase tracking-tighter">Intercepted</span>}</div><input type="text" placeholder="4... / 8..." value={destAddr} onChange={(e) => setDestAddr(e.target.value)} className={`w-full bg-black border p-3 text-[10px] text-white focus:border-[#00ff41] outline-none transition-colors font-black ${isBanned ? 'border-red-600' : 'border-[#004d13]'}`} /></div>
                <div className="space-y-1"><label className="text-[9px] font-black text-xmr-dim uppercase tracking-tighter font-black">Amount (XMR)</label><div className="relative"><input type="number" placeholder="0.00" value={sendAmount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-black border border-[#004d13] p-3 text-lg font-black text-[#00ff41] focus:border-[#00ff41] outline-none" /><button className="absolute right-3 top-3 text-[9px] font-black text-xmr-dim hover:text-white uppercase cursor-pointer font-mono">[ MAX ]</button></div></div>
                <button disabled={isSending || isBanned} onClick={handleSend} className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-4 ${isBanned ? 'bg-red-950 text-red-500 cursor-not-allowed border border-red-600' : 'bg-[#00ff41] text-black hover:bg-white'}`}><Send size={16} /> {isSending ? 'DISPATCHING...' : isBanned ? 'MISSION_ABORTED' : 'CONFIRM_DISPATCH'}</button>
              </div>
            )}
          </div>
        </div>
        <div className="border border-[#004d13] bg-black/20 rounded-sm overflow-hidden flex flex-col h-[350px]">
          <div className="px-4 py-3 border-b border-[#004d13]/20 bg-black/40 text-[9px] font-black uppercase tracking-widest flex justify-between items-center"><span>Identity_Ledger</span><span className="text-[8px] opacity-40 uppercase font-black">{txs.length} Records</span></div>
          <div className="flex-grow overflow-y-auto font-mono text-[9px]">{txs.length > 0 ? (<div className="divide-y divide-[#004d13]/10">{txs.map((tx, i) => (<div key={i} className="p-3 hover:bg-[#00ff41]/5 transition-colors group"><div className="flex justify-between mb-1"><div className="flex items-center gap-2">{tx.isIncoming ? (<ArrowDownLeft size={12} className="text-[#00ff41]" />) : (<ArrowUpRight size={12} className="text-[#ff6600]" />)}<span className={`font-black ${tx.isIncoming ? 'text-[#00ff41]' : 'text-[#ff6600]'}`}>{tx.isIncoming ? '+' : '-'}{tx.amount} XMR</span></div><span className="opacity-30 group-hover:opacity-60 transition-opacity">{new Date(tx.timestamp).toLocaleString()}</span></div><div className="flex justify-between items-center"><code className="opacity-20 group-hover:opacity-40 transition-opacity truncate max-w-[180px]">{tx.id}</code><span className={`text-[8px] font-black px-1.5 py-0.5 rounded-xs ${tx.confirmations >= 10 ? 'bg-[#00ff41]/10 text-[#00ff41]' : 'bg-white/5 text-white/40'}`}>{tx.confirmations >= 10 ? 'CONFIRMED' : `PENDING (${tx.confirmations}/10)`}</span></div></div>))}</div>) : (<div className="h-full flex items-center justify-center italic opacity-20 uppercase tracking-widest font-black">No_Records_Logged</div>)}</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col min-h-screen bg-[#050505] text-[#00ff41] font-mono relative overflow-hidden select-none">
      <style>{` .scanline-overlay { background: linear-gradient(to bottom, transparent 50%, rgba(0, 77, 19, 0.1) 50%); background-size: 100% 4px; pointer-events: none; z-index: 100; display: ${showScanlines ? 'block' : 'none'}; } `}</style>
      <div className="fixed inset-0 scanline-overlay pointer-events-none z-50"></div>
      <header className="h-14 flex items-center px-6 border-b border-[#004d13]/40 bg-black/60 backdrop-blur-md justify-between z-50" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setView('home')}><div className="relative group"><img src="/favicon.svg" className="w-6 h-6 drop-shadow-[0_0_8px_rgba(0,255,65,0.4)] group-hover:scale-110 transition-transform" alt="Logo" /><div className="absolute inset-0 bg-[#00ff41]/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity"></div></div><div className="flex flex-col"><span className="text-xs font-black tracking-[0.4em]">GHOST_TERMINAL</span><span className="text-[8px] opacity-40 font-bold tracking-widest uppercase tracking-[0.2em]">Secure_Uplink</span></div></div>
        <div className="flex items-center gap-6 text-[9px] font-bold">
          <button onClick={() => setView('settings')} className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-all cursor-pointer hover:bg-white/10 ${view === 'settings' ? 'border-white text-white' : 'border-[#004d13] text-xmr-dim'}`}><Settings size={10} /> CONFIG</button>
          <button onClick={() => setUseTor(!torEnabled)} className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-all cursor-pointer ${torEnabled ? 'bg-[#00ff41]/10 border-[#00ff41] text-[#00ff41]' : 'bg-black/40 border-[#004d13] text-xmr-dim opacity-50'}`}><Zap size={10} className={torEnabled ? 'animate-pulse' : ''} />{torEnabled ? 'TOR_ACTIVE' : 'CLEARNET'}</button>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#00ff41]/5 border border-[#00ff41]/20 opacity-50 font-mono italic tracking-tighter uppercase font-black">
            <Database size={10} /> {status}
          </div>
        </div>
      </header>
      <main className="flex-grow p-8 relative z-10 overflow-y-auto">
        {view === 'home' && renderHome()}
        {view === 'vault' && renderVault()}
        {view === 'swap' && <SwapView localXmrAddress={address} />}
        {view === 'settings' && <SettingsView />}
      </main>
      <footer className="h-10 px-6 border-t border-[#004d13]/20 bg-black/40 flex justify-between items-center z-50 text-[8px] font-bold text-[#00661a] font-mono font-black">
        <div className="flex gap-4 uppercase tracking-[0.1em]"><span>ID: [ {address.substring(0,8)} ]</span><span>UPTIME: [ 00:42:12 ]</span></div>
        <div className="uppercase tracking-[0.2em]"><span>© 2026 kyc.rip // secure_terminal</span></div>
      </footer>
    </div>
  );
}

export default function App() { return (<TorProvider><MainApp /></TorProvider>); }
