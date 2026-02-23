import React, { useState } from 'react';
import { PlusCircle, Check, Trash2, ChevronDown, ChevronUp, Users, AlertCircle } from 'lucide-react';

interface Identity {
  id: string;
  name: string;
}

interface IdentitySwitcherProps {
  identities: Identity[];
  activeId: string;
  onSwitchIdentity: (id: string) => void;
  onStartNew: () => void;
  onPurge: (id: string) => void;
}

export function IdentitySwitcher({ identities, activeId, onSwitchIdentity, onStartNew, onPurge }: IdentitySwitcherProps) {
  const [showSwitcher, setShowSwitcher] = useState(false);

  // Even with one identity, show "New Identity" button for expandability
  const hasMultiple = identities.length > 1;

  return (
    <div className="mt-6 pt-4 border-t border-xmr-border/20">
      <div className="flex gap-2">
        {/* Switcher trigger */}
        <button
          type="button"
          onClick={() => setShowSwitcher(!showSwitcher)} 
          className={`flex-grow flex justify-between items-center px-2 py-1.5 text-[9px] font-black uppercase tracking-widest transition-all border ${showSwitcher ? 'border-xmr-green text-xmr-green' : 'border-xmr-border/50 text-xmr-dim hover:text-xmr-green'}`}
        >
          <div className="flex items-center gap-2">
            <Users size={12} />
            <span>Profiles ({identities.length})</span>
          </div>
          {showSwitcher ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>

        {/* Quick creation button */}
        <button
          onClick={onStartNew}
          className="px-3 border border-xmr-border/50 text-xmr-dim hover:border-xmr-green hover:text-xmr-green transition-all"
          title="REGISTER_NEW_ID"
        >
          <PlusCircle size={14} />
        </button>
      </div>

       {showSwitcher && (
        <div className="mt-4 max-h-48 overflow-y-auto pr-1 custom-scrollbar space-y-1.5 animate-in slide-in-from-top-2 duration-300">
            {identities.map(id => (
              <div key={id.id} className="group flex gap-1.5 animate-in fade-in slide-in-from-left-2">
                <button 
                  type="button" 
                  onClick={() => {
                    onSwitchIdentity(id.id);
                    setShowSwitcher(false);
                  }}
                  className={`flex-grow px-3 py-2 text-[9px] font-black border uppercase transition-all flex items-center justify-between cursor-pointer relative overflow-hidden ${id.id === activeId
                      ? 'border-xmr-green text-xmr-green bg-xmr-green/10 shadow-[inset_0_0_10px_rgba(0,255,65,0.05)]'
                      : 'border-xmr-border/30 text-xmr-dim/60 hover:border-xmr-green/50 hover:text-xmr-green'
                    }`}
                >
                  <div className="flex items-center gap-2">
                    {id.id === activeId && <div className="w-1 h-1 bg-xmr-green rounded-full animate-pulse" />}
                    <span className="truncate">{id.name}</span>
                  </div>
                  {id.id === activeId ? (
                    <span className="text-[7px] bg-xmr-green/20 px-1 border border-xmr-green/30">ACTIVE</span>
                  ) : (
                    <span className="opacity-0 group-hover:opacity-100 text-[7px] transition-opacity">SELECT_</span>
                  )}
                </button>

                {/* Delete button: includes confirmation logic */}
                <button 
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`⚠️ PURGE IDENTITY: [${id.name}]?\nThis action will erase local keys for this profile.`)) {
                      onPurge(id.id);
                    }
                  }}
                  className="px-2 border border-red-900/20 text-red-900/40 hover:border-red-600 hover:text-red-600 hover:bg-red-600/5 transition-all cursor-pointer"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
         </div>
       )}
    </div>
  );
}