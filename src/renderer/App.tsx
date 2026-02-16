import React, { useState, useEffect } from 'react';
import { Shield, Zap, Lock, Ghost, Database, Plus, RefreshCw, Send, Download, Copy, Check, ShieldAlert, Skull, Settings, ArrowUpRight, ArrowDownLeft, Key, EyeOff } from 'lucide-react';
import { useVault } from './hooks/useVault';
import { SwapView } from './components/SwapView';
import { SettingsView } from './components/SettingsView';
import { HomeView } from './components/HomeView';
import { VaultView } from './components/VaultView';
import { TorProvider, useTor } from './contexts/TorContext';
import { StealthStep } from './services/stealth/types';

function MainApp() {
  const [view, setView] = useState<'home' | 'vault' | 'swap' | 'settings'>('home');
  const vault = useVault();
  const { address, logs, status, isInitializing, syncPercent } = vault;
  const { useTor: torEnabled, setUseTor } = useTor();
  
  // Settings & UI State
  const [showScanlines, setShowScanlines] = useState(true);
  const [uplink, setUplink] = useState<string>('SCANNING...');

  // Load UI specific settings
  useEffect(() => {
    (window as any).api.getConfig('show_scanlines').then((v: boolean) => {
      if (v !== undefined) setShowScanlines(v);
    });
  }, [view]);

  // Poll Uplink Status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const s = await (window as any).api.getUplinkStatus();
        if (s && s.target) {
          const cleanUrl = s.target.replace('http://', '').replace('https://', '');
          setUplink(cleanUrl);
        }
      } catch (e) {
        setUplink('LINK_OFFLINE');
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleBurn = async () => {
    if (confirm("🚨 WARNING: This will PERMANENTLY erase your local Master Seed and exit. Are you sure?")) {
      await (window as any).api.burnIdentity();
      location.reload();
    }
  };

  if (isInitializing) {
    const displayPercent = Math.max(syncPercent, 0);
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-[#050505] text-[#00ff41] font-mono p-10 relative overflow-hidden">
        <style>{`
          @keyframes progress-indeterminate { 0% { transform: translateX(-100%) scaleX(0.2); } 50% { transform: translateX(0%) scaleX(0.5); } 100% { transform: translateX(100%) scaleX(0.2); } }
          .scanline-overlay { background: linear-gradient(to bottom, transparent 50%, rgba(0, 77, 19, 0.1) 50%); background-size: 100% 4px; pointer-events: none; z-index: 100; }
        `}</style>
        <div className="fixed inset-0 scanline-overlay pointer-events-none z-50"></div>
        
        {/* Rescue Settings Entry */}
        <div className="absolute top-6 right-6 z-[60]" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button 
            onClick={() => setView(view === 'settings' ? 'home' : 'settings')}
            className="flex items-center gap-2 px-3 py-1.5 border border-[#004d13] text-[9px] font-black text-xmr-dim hover:text-[#00ff41] hover:border-[#00ff41] transition-all cursor-pointer uppercase"
          >
            <Settings size={12} /> {view === 'settings' ? 'Close_Config' : 'Rescue_Config'}
          </button>
        </div>

        {view === 'settings' ? (
          <div className="w-full max-w-4xl z-[60] bg-[#050505] p-4 border border-[#004d13] shadow-[0_0_50px_rgba(0,255,65,0.1)] overflow-y-auto max-h-[80vh]">
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
               <div className="text-[8px] text-[#00661a] space-y-1 font-bold uppercase tracking-tighter">
                  {logs.slice(0, 6).map((l, i) => (<p key={i} className={`truncate ${i === 0 ? 'text-[#00ff41]' : 'opacity-60'}`}>{'>'} {l}</p>))}
               </div>
            </div>
            {status === StealthStep.ERROR && (
              <button 
                onClick={() => location.reload()} 
                className="mt-8 px-6 py-2 border border-[#00ff41] text-[#00ff41] text-[10px] font-black hover:bg-[#00ff41] hover:text-black transition-all cursor-pointer uppercase"
              >
                Reconnect_Manual_Override
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#050505] text-[#00ff41] font-mono relative overflow-hidden select-none">
      <style>{` .scanline-overlay { background: linear-gradient(to bottom, transparent 50%, rgba(0, 77, 19, 0.1) 50%); background-size: 100% 4px; pointer-events: none; z-index: 100; display: ${showScanlines ? 'block' : 'none'}; } `}</style>
      <div className="fixed inset-0 scanline-overlay pointer-events-none z-50"></div>
      
      <header className="shrink-0 h-14 flex items-center pl-20 pr-6 border-b border-[#004d13]/40 bg-black/60 backdrop-blur-md justify-between z-50" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="flex items-center gap-3 cursor-pointer" onClick={() => setView('home')} style={{ WebkitAppRegion: 'no-drag' } as any}>
          <div className="relative group">
            <img src="/favicon.svg" className="w-6 h-6 drop-shadow-[0_0_8px_rgba(0,255,65,0.4)] group-hover:scale-110 transition-transform" alt="Logo" />
            <div className="absolute inset-0 bg-[#00ff41]/20 blur-xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-black tracking-[0.4em]">GHOST_TERMINAL</span>
            <span className="text-[8px] opacity-40 font-bold tracking-widest uppercase tracking-[0.2em]">Secure_Uplink</span>
          </div>
        </div>
        <div className="flex items-center gap-6 text-[9px] font-bold" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button 
            onClick={() => setView('settings')} 
            className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-all cursor-pointer hover:bg-white/10 ${view === 'settings' ? 'border-white text-white' : 'border-[#004d13] text-xmr-dim'}`}
          >
            <Settings size={10} /> CONFIG
          </button>
          <button 
            onClick={() => setUseTor(!torEnabled)} 
            className={`flex items-center gap-1.5 px-2 py-1 rounded border transition-all cursor-pointer ${torEnabled ? 'bg-[#00ff41]/10 border-[#00ff41] text-[#00ff41]' : 'bg-black/40 border-[#004d13] text-xmr-dim opacity-50'}`}
          >
            <Zap size={10} className={torEnabled ? 'animate-pulse' : ''} />{torEnabled ? 'TOR_ACTIVE' : 'CLEARNET'}
          </button>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-[#00ff41]/5 border border-[#00ff41]/20 opacity-50 font-mono italic tracking-tighter uppercase font-black">
            <Database size={10} /> {status}
          </div>
        </div>
      </header>

      <main className="flex-grow overflow-y-auto p-8 relative z-10 custom-scrollbar">
        {view === 'home' && <HomeView setView={setView} />}
        {view === 'vault' && <VaultView setView={setView} vault={vault} handleBurn={handleBurn} />}
        {view === 'swap' && <SwapView localXmrAddress={address} />}
        {view === 'settings' && <SettingsView />}
      </main>

      <footer className="shrink-0 h-10 px-6 border-t border-[#004d13]/20 bg-black/40 flex justify-between items-center z-50 text-[8px] font-bold text-[#00661a] font-mono font-black">
        <div className="flex gap-4 uppercase tracking-[0.1em]">
          <span>ID: [ {address.substring(0,8)} ]</span>
          <span className="flex items-center gap-1">
            UPLINK: [ <span className="text-[#00ff41]">{uplink || 'SCANNING...'}</span> ]
          </span>
        </div>
        <div className="uppercase tracking-[0.2em] flex items-center gap-2">
          <span className="animate-pulse text-[#00ff41]">●</span>
          <span>© 2026 kyc.rip // secure_terminal</span>
        </div>
      </footer>
    </div>
  );
}

export default function App() { return (<TorProvider><MainApp /></TorProvider>); }
