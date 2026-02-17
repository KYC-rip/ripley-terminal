import React, { useState } from 'react';
import { PlusCircle, Check, Trash2, ChevronDown, ChevronUp } from 'lucide-react';

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

  // If there's only one identity, we don't need a complex sidebar, but keeping consistent styling is good.
  // For the vertical layout we adopted, this is actually the foldable switcher at the bottom of the card.
  
  // WAIT: In the latest vertical layout, the sidebar is gone. We are using a FOLDABLE SWITCHER inside the card.
  // So this component should represent that foldable section.

  if (identities.length <= 1) return null;

  return (
    <div className="mt-6 pt-4 border-t border-xmr-border/20">
       <button 
         type="button"
         onClick={() => setShowSwitcher(!showSwitcher)} 
         className="w-full flex justify-between items-center text-[9px] font-black text-xmr-dim hover:text-xmr-green uppercase tracking-widest transition-all"
       >
          <span>Switch_Active_Identity ({identities.length})</span>
          {showSwitcher ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
       </button>
       
       {showSwitcher && (
         <div className="mt-4 max-h-48 overflow-y-auto pr-1 custom-scrollbar space-y-2 animate-in slide-in-from-top-2 duration-200">
            {identities.map(id => (
              <div key={id.id} className="flex gap-2">
                <button 
                  type="button" 
                  onClick={() => { onSwitchIdentity(id.id); setShowSwitcher(false); }} 
                  className={`flex-grow px-2 py-1.5 text-[9px] font-black border uppercase transition-all flex items-center justify-between cursor-pointer ${id.id === activeId ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-xmr-border text-xmr-dim hover:border-xmr-green/50'}`}
                >
                  <span className="truncate pr-1">{id.name}</span>
                  {id.id === activeId && <Check size={10} />}
                </button>
                <button 
                  type="button"
                  onClick={() => onPurge(id.id)}
                  className="px-2 border border-red-900/30 text-red-900 hover:border-red-600 hover:text-red-600 transition-all cursor-pointer"
                  title="Purge Identity"
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
