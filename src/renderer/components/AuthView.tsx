import React, { useState } from 'react';
import { Lock, Shield, Skull, RefreshCw, Key, Users, PlusCircle, Check, ShieldCheck, Download, Sparkles, ArrowLeft, Calendar, ChevronDown, ChevronUp } from 'lucide-react';
import { Card } from './Card';

interface Identity { id: string; name: string; created: number; }

interface AuthViewProps {
  onUnlock: (password: string, restoreSeed?: string, restoreHeight?: number, newIdentityName?: string) => void;
  isInitialSetup: boolean;
  identities: Identity[];
  activeId: string;
  onSwitchIdentity: (id: string) => void;
  onCreateIdentity: (name: string) => void;
  onPurgeIdentity: (id: string) => void;
  logs?: string[];
}

type SetupStep = 'AUTH' | 'LABEL' | 'MODE' | 'RESTORE' | 'NEW_PASSWORD';

export function AuthView({ onUnlock, isInitialSetup, identities, activeId, onSwitchIdentity, onCreateIdentity, onPurgeIdentity, logs = [] }: AuthViewProps) {
  const [step, setStep] = useState<SetupStep>(isInitialSetup ? 'LABEL' : 'AUTH');
  const [showSwitcher, setShowSwitcher] = useState(false);
  
  // Form States
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [restoreSeed, setRestoreSeed] = useState('');
  const [restoreHeight, setRestoreHeight] = useState('');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const activeIdentity = identities.find(i => i.id === activeId) || identities[0];

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) return;
    if (step === 'RESTORE' || step === 'NEW_PASSWORD' || isInitialSetup) {
      if (password.length < 8) { setError('SECRET_TOO_SHORT: MIN 8 CHARS'); return; }
      if (password !== confirmPassword) { setError('PASSWORDS_DO_NOT_MATCH'); return; }
    }
    setIsProcessing(true);
    setError('');
    setTimeout(async () => {
      try {
        const height = restoreHeight ? parseInt(restoreHeight) : undefined;
        const isCreating = step !== 'AUTH';
        await onUnlock(password, step === 'RESTORE' ? restoreSeed : undefined, height, isCreating ? newName : undefined);
      } catch (err: any) {
        const msg = err.message || '';
        if (msg.includes('INVALID_SECRET')) setError('ACCESS_DENIED: WRONG PASSWORD');
        else if (msg.includes('Timeout')) setError('UPLINK_TIMEOUT: CHECK TOR STATUS');
        else setError(`ENGINE_ERROR: ${msg.toUpperCase()}`);
        setIsProcessing(false);
      }
    }, 800);
  };

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-xmr-base text-xmr-green font-mono p-6 relative overflow-y-auto custom-scrollbar">
      <div className="fixed inset-0 scanline-overlay pointer-events-none z-50 opacity-[0.05]"></div>
      
      <div className="w-full max-w-md space-y-6 relative z-10 animate-in fade-in zoom-in-95 duration-500 py-10">
        {/* HEADER */}
        <div className="text-center space-y-3">
          <div className="inline-block p-3 rounded-full bg-xmr-green/10 border border-xmr-green/20 mb-1">
            {step === 'AUTH' ? <Shield size={40} className={isProcessing ? 'animate-pulse' : ''} /> : <ShieldCheck size={40} />}
          </div>
          <h1 className="text-2xl font-black italic uppercase text-xmr-green tracking-tighter">
            {step === 'RESTORE' ? 'Identity_Recovery' : step === 'NEW_PASSWORD' ? 'Initialize_Vault' : isInitialSetup ? 'Welcome_Operative' : 'Vault_Authorization'}
          </h1>
          <div className="flex items-center justify-center gap-2 text-[9px] text-xmr-dim uppercase tracking-widest">
             <Users size={10} />
             <span>Active_ID: <span className="text-xmr-green font-black">{newName || activeIdentity?.name || 'INITIALIZING'}</span></span>
          </div>
        </div>

        <Card topGradientAccentColor={step === 'AUTH' ? 'xmr-accent' : 'xmr-green'} className="p-8 shadow-2xl relative">
          <form onSubmit={handleUnlockSubmit} className="space-y-6">
            
            {/* 1. LABEL STEP */}
            {step === 'LABEL' && (
              <div className="space-y-4 animate-in fade-in duration-300">
                 <div className="space-y-1">
                    <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Identity_Label</label>
                    <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. PRIMARY_VAULT" className="w-full bg-xmr-base border border-xmr-border p-3 text-lg font-black text-xmr-green outline-none focus:border-xmr-green transition-all" />
                 </div>
                 <button type="button" onClick={() => { if(newName) setStep('MODE'); }} disabled={!newName} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-white hover:text-black transition-all disabled:opacity-30">Next_Step</button>
              </div>
            )}

            {/* 2. MODE STEP */}
            {step === 'MODE' && (
              <div className="grid grid-cols-1 gap-3 animate-in fade-in duration-300">
                 <button type="button" onClick={() => setStep('NEW_PASSWORD')} className="p-5 border border-xmr-border bg-xmr-green/5 hover:border-xmr-green hover:bg-xmr-green/10 transition-all text-left group">
                    <div className="flex items-center gap-3 mb-1"><Sparkles className="text-xmr-green" size={18} /><span className="text-sm font-black uppercase text-xmr-green">Generate_New</span></div>
                    <p className="text-[8px] text-xmr-dim uppercase">Derive fresh 25-word mnemonic phrase.</p>
                 </button>
                 <button type="button" onClick={() => setStep('RESTORE')} className="p-5 border border-xmr-border bg-xmr-accent/5 hover:border-xmr-accent hover:bg-xmr-accent/10 transition-all text-left group">
                    <div className="flex items-center gap-3 mb-1"><Download className="text-xmr-accent" size={18} /><span className="text-sm font-black uppercase text-xmr-accent">Restore_Existing</span></div>
                    <p className="text-[8px] text-xmr-dim uppercase">Import identity from private backup seed.</p>
                 </button>
                 <button type="button" onClick={() => setStep('LABEL')} className="mt-2 text-[9px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors"><ArrowLeft size={12}/> Back</button>
              </div>
            )}

            {/* 3. AUTH / RESTORE / NEW_PASSWORD FORM */}
            {(step === 'AUTH' || step === 'RESTORE' || step === 'NEW_PASSWORD') && (
              <div className="space-y-5 animate-in slide-in-from-bottom-2 duration-300">
                {step === 'RESTORE' && (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <label className="text-[9px] font-black text-xmr-dim uppercase ml-1 flex justify-between"><span>Mnemonic_Seed (25 words)</span><span className="text-xmr-accent font-black">STANDARD_ONLY</span></label>
                      <textarea rows={2} value={restoreSeed} onChange={(e) => setRestoreSeed(e.target.value)} placeholder="word1 word2 ..." className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none resize-none" />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-black text-xmr-dim uppercase ml-1 flex items-center gap-2"><Calendar size={10} /> Restore_Height (Optional)</label>
                      <input type="number" value={restoreHeight} onChange={(e) => setRestoreHeight(e.target.value)} placeholder="e.g. 3000000" className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none" />
                    </div>
                  </div>
                )}

                <div className="space-y-1">
                  <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">{step === 'AUTH' ? 'Vault_Secret' : 'Set_Master_Password'}</label>
                  <div className="relative">
                    <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" className="w-full bg-xmr-base border border-xmr-border p-3 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20" />
                    <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-xmr-dim opacity-30" size={20} />
                  </div>
                </div>

                {step !== 'AUTH' && (
                  <div className="space-y-1">
                    <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Confirm_Password</label>
                    <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••••••" className="w-full bg-xmr-base border border-xmr-border p-3 text-xl font-black text-xmr-green focus:border-xmr-green outline-none" />
                  </div>
                )}

                {error && <div className="p-3 bg-red-900/20 border border-red-600/50 text-red-500 text-[10px] font-black uppercase flex items-center gap-2 animate-shake"><Skull size={14} /> {error}</div>}

                {isProcessing && logs.length > 0 && (
                  <div className="p-3 bg-xmr-green/5 border border-xmr-green/10 rounded-sm space-y-1 overflow-hidden">
                     {logs.slice(0, 3).map((log, i) => (<p key={i} className={`text-[8px] uppercase truncate font-black ${i === 0 ? 'text-xmr-green' : 'text-xmr-dim opacity-60'}`}>{'>'} {log}</p>))}
                  </div>
                )}

                <button disabled={isProcessing || !password || (step !== 'AUTH' && !confirmPassword)} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.3em] hover:bg-white hover:text-black transition-all flex items-center justify-center gap-3 group disabled:opacity-30 cursor-pointer">
                  {isProcessing ? <><RefreshCw size={18} className="animate-spin" /> Authorizing...</> : <><Key size={18} className="group-hover:scale-110 transition-transform" /> {step === 'RESTORE' ? 'Initiate_Recovery' : step === 'NEW_PASSWORD' ? 'Establish_Vault' : 'Unlock_Identity'}</>}
                </button>
                
                {!isProcessing && step !== 'AUTH' && (
                   <button type="button" onClick={() => setStep('MODE')} className="w-full text-[9px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> Back_To_Strategy</button>
                )}
              </div>
            )}
          </form>

          {/* FOLDABLE IDENTITY SWITCHER */}
          {!isProcessing && identities.length > 1 && (
            <div className="mt-6 pt-4 border-t border-xmr-border/20">
               <button onClick={() => setShowSwitcher(!showSwitcher)} className="w-full flex justify-between items-center text-[9px] font-black text-xmr-dim hover:text-xmr-green uppercase tracking-widest transition-all">
                  <span>Switch_Active_Identity ({identities.length})</span>
                  {showSwitcher ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
               </button>
               {showSwitcher && (
                 <div className="mt-4 max-h-32 overflow-y-auto pr-1 custom-scrollbar grid grid-cols-2 gap-2 animate-in slide-in-from-top-2 duration-200">
                    {identities.map(id => (
                      <button key={id.id} type="button" onClick={() => { onSwitchIdentity(id.id); setShowSwitcher(false); }} className={`px-2 py-1.5 text-[9px] font-black border uppercase transition-all flex items-center justify-between cursor-pointer ${id.id === activeId ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-xmr-border text-xmr-dim hover:border-xmr-green/50'}`}>
                        <span className="truncate pr-1">{id.name}</span>
                        {id.id === activeId && <Check size={10} />}
                      </button>
                    ))}
                 </div>
               )}
            </div>
          )}

          {/* CREATE NEW LINK */}
          {!isProcessing && step === 'AUTH' && (
            <div className="mt-4 flex justify-center">
               <button type="button" onClick={() => setStep('LABEL')} className="text-[9px] text-xmr-dim hover:text-xmr-green flex items-center gap-2 uppercase font-black transition-all cursor-pointer">
                 <PlusCircle size={12} /> Create_New_Identity
               </button>
            </div>
          )}
        </Card>

        {/* FOOTER ACTIONS */}
        <div className="text-center space-y-4 pt-4">
          <p className="text-[8px] text-xmr-dim uppercase leading-relaxed max-w-xs mx-auto opacity-60">
            IMPORTANT: Password used to encrypt local keys. <br/>
            Zero-knowledge isolation active.
          </p>
          {step === 'AUTH' && !isInitialSetup && (
            <button onClick={() => onPurgeIdentity(activeId)} className="text-[8px] text-red-900 hover:text-red-500 uppercase font-black underline decoration-dotted underline-offset-4 transition-colors cursor-pointer flex items-center justify-center gap-2 mx-auto">
               [ Nuclear_Identity_Purge ]
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
