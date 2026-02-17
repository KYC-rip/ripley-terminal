import React, { useState, useEffect } from 'react';
import { Shield, Zap, Ghost, Database, Settings, Skull, Sun, Moon, Monitor } from 'lucide-react';
import { useVault } from './hooks/useVault';
import { useStats } from './hooks/useStats';
import { useTheme } from './hooks/useTheme';
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
  const { stats } = useStats();
  const { mode, cycleTheme, resolvedTheme } = useTheme();
  
  // Settings & UI State
  const [showScanlines, setShowScanlines] = useState(true);
  const [uplink, setUplink] = useState<string>('SCANNING...');
  const [sessionStartTime] = useState(Date.now());
  const [uptime, setUptime] = useState('00:00:00');

  // Uptime Counter
  useEffect(() => {
    const timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - sessionStartTime) / 1000);
      const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
      const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
      const s = (seconds % 60).toString().padStart(2, '0');
      setUptime(`${h}:${m}:${s}`);
    }, 1000);
    return () => clearInterval(timer);
  }, [sessionStartTime]);

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
          let cleanUrl = s.target.replace('http://', '').replace('https://', '');
          if (cleanUrl.includes('.onion')) {
            const parts = cleanUrl.split('.');
            if (parts[0].length > 12) {
              cleanUrl = `${parts[0].substring(0, 12)}...onion${parts[1] ? ':' + parts[1].split(':')[1] : ''}`;
            }
          }
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
      <div className="flex flex-col items-center justify-center min-h-screen bg-xmr-base text-xmr-green font-mono p-10 relative overflow-hidden" style={{ WebkitAppRegion: 'drag' } as any}>
        <style>{`
          @keyframes progress-indeterminate { 0% { transform: translateX(-100%) scaleX(0.2); } 50% { transform: translateX(0%) scaleX(0.5); } 100% { transform: translateX(100%) scaleX(0.2); } }
          .scanline-overlay { background: linear-gradient(to bottom, transparent 50%, rgba(0, 77, 19, ${resolvedTheme === 'dark' ? '0.1' : '0.02'}) 50%); background-size: 100% 4px; pointer-events: none; z-index: 100; }
        `}</style>
        <div className="fixed inset-0 scanline-overlay pointer-events-none z-50"></div>
        
        <div className="flex flex-col items-center" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <Shield size={48} className="animate-pulse mb-6 text-xmr-green" />
          <div className="flex flex-col items-center gap-3 w-full max-w-xs">
            <div className="flex justify-between w-full text-[10px] font-black uppercase tracking-widest opacity-80">
              <span>Tor_Uplink_Sequence</span>
              <span>ACTIVE</span>
            </div>
            <div className="w-full h-1 bg-xmr-border rounded-full overflow-hidden relative border border-xmr-green/20">
              <div className="absolute inset-0 bg-xmr-green animate-[progress-indeterminate_2s_infinite_linear]"></div>
            </div>
          </div>
          <div className="mt-12 w-full max-w-sm border-l border-xmr-green/20 pl-4">
              <div className="text-[8px] text-xmr-dim space-y-1 font-bold uppercase tracking-tighter">
                {logs.slice(0, 6).map((l, i) => (<p key={i} className={`truncate ${i === 0 ? 'text-xmr-green' : 'opacity-60'}`}>{'>'} {l}</p>))}
              </div>
          </div>
        </div>
      </div>
    );
  }

  const NavButton = ({ id, label, icon: Icon }: any) => (
    <button 
      onClick={() => setView(id)}
      className={`w-full flex items-center gap-3 px-6 py-4 border-l-2 transition-all cursor-pointer group ${view === id ? 'bg-xmr-green/5 border-xmr-green text-xmr-green' : 'border-transparent text-xmr-dim hover:text-xmr-green hover:bg-xmr-green/5'}`}
    >
      <Icon size={18} className={view === id ? 'drop-shadow-[0_0_8px_rgba(0,255,65,0.5)]' : 'opacity-50 group-hover:opacity-100'} />
      <span className="text-[11px] font-black uppercase tracking-[0.2em]">{label}</span>
    </button>
  );

  return (
    <div className="flex h-screen bg-xmr-base text-xmr-green font-mono relative overflow-hidden select-none transition-colors duration-300">
      <style>{` .scanline-overlay { background: linear-gradient(to bottom, transparent 50%, rgba(0, 77, 19, ${resolvedTheme === 'dark' ? '0.1' : '0.02'}) 50%); background-size: 100% 4px; pointer-events: none; z-index: 100; display: ${showScanlines ? 'block' : 'none'}; } `}</style>
      <div className="fixed inset-0 scanline-overlay pointer-events-none z-[100]"></div>
      
      {/* SIDEBAR */}
      <aside className="w-64 shrink-0 flex flex-col border-r border-xmr-border/40 bg-xmr-surface backdrop-blur-xl z-50" style={{ WebkitAppRegion: 'drag' } as any}>
        <div className="p-8 pb-10 flex flex-col items-center gap-3" style={{ WebkitAppRegion: 'no-drag' } as any}>
           <div className="relative group cursor-pointer" onClick={() => setView('home')}>
             <img src="/favicon.svg" className={`w-10 h-10 ${resolvedTheme === 'light' ? 'invert' : ''} drop-shadow-[0_0_12px_rgba(0,255,65,0.4)]`} alt="Logo" />
             <div className="absolute inset-0 bg-xmr-green/20 blur-2xl opacity-0 group-hover:opacity-100 transition-opacity"></div>
           </div>
           <div className="text-center">
             <div className="text-xs font-black tracking-[0.4em] text-xmr-green">GHOST_TERMINAL</div>
             <div className="text-[7px] text-xmr-dim font-bold tracking-[0.3em] uppercase mt-1">v1.0.0_Tactical_Uplink</div>
           </div>
        </div>

        <nav className="flex-grow space-y-1" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <NavButton id="home" label="Dashboard" icon={Ghost} />
          <NavButton id="vault" label="Vault_Storage" icon={Shield} />
          <NavButton id="swap" label="Vanish_Swap" icon={Zap} />
          <NavButton id="settings" label="Config_System" icon={Settings} />
        </nav>

        {/* SIDEBAR BOTTOM STATUS */}
        <div className="p-6 space-y-4 border-t border-xmr-border/20 bg-xmr-green/[0.02]" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <div className="space-y-2">
             <div className="flex justify-between items-center text-[8px] font-black uppercase tracking-widest">
                <span className="text-xmr-dim">THEME_MODE</span>
                <button onClick={cycleTheme} className="flex items-center gap-1.5 px-2 py-0.5 rounded border border-xmr-border hover:bg-xmr-green/10 transition-all cursor-pointer text-xmr-green">
                  {mode === 'dark' && <Moon size={10} />}
                  {mode === 'light' && <Sun size={10} />}
                  {mode === 'system' && <Monitor size={10} />}
                  {mode.toUpperCase()}
                </button>
             </div>
             <div className="flex justify-between items-center text-[8px] font-black uppercase tracking-widest">
                <span className="text-xmr-dim">NETWORK_MODE</span>
                <button onClick={() => setUseTor(!torEnabled)} className={`px-1.5 py-0.5 rounded border ${torEnabled ? 'border-xmr-green text-xmr-green' : 'border-xmr-accent text-xmr-accent'} cursor-pointer`}>
                  {torEnabled ? 'TOR_ONLY' : 'CLEARNET'}
                </button>
             </div>
             <div className="flex justify-between items-center text-[8px] font-black uppercase tracking-widest">
                <span className="text-xmr-dim">SESSION_TIME</span>
                <span className="text-xmr-green opacity-80">{uptime}</span>
             </div>
             <div className="flex justify-between items-center text-[8px] font-black uppercase tracking-widest">
                <span className="text-xmr-dim">UPLINK_STATUS</span>
                <span className="text-xmr-green flex items-center gap-1"><div className="w-1 h-1 bg-xmr-green rounded-full animate-pulse"></div> {status === 'SYNCING' || syncPercent < 100 ? `${syncPercent.toFixed(1)}%` : status}</span>
             </div>
          </div>
          
          <div className="pt-2 border-t border-xmr-border/10">
             <div className="text-[7px] text-xmr-dim leading-relaxed uppercase italic">
                Uplink: {uplink || 'Scanning...'}
             </div>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <div className="flex-grow flex flex-col min-w-0 bg-xmr-base">
        <header className="h-14 flex items-center justify-end px-8 border-b border-xmr-border/20 bg-xmr-surface shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
          <div className="flex gap-6 text-[8px] font-black uppercase tracking-[0.2em]" style={{ WebkitAppRegion: 'no-drag' } as any}>
             <span className="flex items-center gap-2 text-xmr-dim">SESSION: <span className="text-xmr-green opacity-80 font-black">{uptime}</span></span>
             <span className="flex items-center gap-2 text-xmr-dim">XMR: <span className="text-xmr-accent font-black">${stats?.price.street || '---.--'}</span></span>
             <span className="flex items-center gap-2 text-xmr-dim">POOL: <span className={(stats?.network.mempool || 0) > 50 ? "text-xmr-accent" : "text-xmr-green"}>{stats?.network.mempool ?? '--'} TXs</span></span>
          </div>
        </header>

        <main className="flex-grow overflow-y-auto p-10 custom-scrollbar relative">
          <div className={`absolute top-0 left-0 w-full h-32 bg-gradient-to-b from-xmr-green/5 to-transparent pointer-events-none`}></div>
          {view === 'home' && <HomeView setView={setView} />}
          {view === 'vault' && <VaultView setView={setView} vault={vault} handleBurn={handleBurn} />}
          {view === 'swap' && <SwapView localXmrAddress={address} />}
          {view === 'settings' && <SettingsView />}
        </main>

        <footer className="h-8 border-t border-xmr-border/10 px-8 flex justify-between items-center text-[7px] font-black text-xmr-dim uppercase tracking-widest shrink-0">
           <span>© 2026 kyc.rip // tactical_terminal_v1.0</span>
           <div className="flex gap-4">
              <span>ID: {address.substring(0, 12)}...</span>
              <span className="animate-pulse">● System_Operational</span>
           </div>
        </footer>
      </div>
    </div>
  );
}

export default function App() { return (<TorProvider><MainApp /></TorProvider>); }
