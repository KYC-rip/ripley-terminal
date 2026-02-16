import React from 'react';
import { Lock, Ghost, Activity } from 'lucide-react';

interface HomeViewProps {
  setView: (v: 'home' | 'vault' | 'swap' | 'settings') => void;
}

export function HomeView({ setView }: HomeViewProps) {
  return (
    <div className="max-w-4xl mx-auto space-y-12 py-10 animate-in slide-in-from-bottom-4 duration-500 font-black">
      <section className="space-y-6 pt-10 border-l-2 border-[#00ff41]/20 pl-8 font-black text-white">
        <div className="space-y-2">
          <h1 className="text-6xl font-black tracking-tighter italic uppercase leading-none font-mono">
            Sovereign <br/> Vault_Portal
          </h1>
          <div className="h-1 w-32 bg-[#00ff41]"></div>
        </div>
        <p className="text-[10px] opacity-60 max-w-md leading-relaxed uppercase tracking-[0.2em]">
          Authorized Local Instance. Hardware-agnostic encryption layer active. Secure session established.
        </p>
      </section>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-6 font-mono font-black max-w-3xl">
        <div onClick={() => setView('vault')} className="p-6 border border-[#004d13] bg-black/40 rounded-sm hover:border-[#00ff41] hover:bg-[#00ff41]/5 transition-all cursor-pointer group">
          <Lock size={24} className="mb-4 text-[#00ff41]" />
          <h3 className="text-lg font-bold mb-2 uppercase">Enter_Vault</h3>
          <p className="text-[9px] opacity-40 uppercase leading-loose text-xmr-dim">Identity management and ledger analysis.</p>
          <div className="mt-8 flex justify-between items-center text-[10px] font-black opacity-0 group-hover:opacity-100 transition-all">
            <span>UNLOCKED</span>
            <span>[ OPEN ]</span>
          </div>
        </div>

        <div onClick={() => setView('swap')} className="p-6 border border-[#004d13] bg-black/40 rounded-sm hover:border-[#ff6600] hover:bg-[#ff6600]/5 transition-all cursor-pointer group">
          <Ghost size={24} className="mb-4 text-[#ff6600]" />
          <h3 className="text-lg font-bold mb-2 uppercase text-[#ff6600]">Ghost_Swap</h3>
          <p className="text-[9px] opacity-40 uppercase leading-loose text-xmr-dim">Bridge clear-net assets via tactical dark-routing.</p>
          <div className="mt-8 flex justify-between items-center text-[10px] font-black opacity-0 group-hover:opacity-100 transition-all text-[#ff6600]">
            <span>ROUTING</span>
            <span>[ INIT ]</span>
          </div>
        </div>
      </div>
    </div>
  );
}
