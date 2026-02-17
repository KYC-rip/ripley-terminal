import React, { useState } from 'react';
import { Lock, Shield, Skull, RefreshCw, Key, Users, PlusCircle, Check, ShieldCheck, Download, Sparkles, ArrowLeft, Calendar } from 'lucide-react';
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

  if (step === 'LABEL') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-xmr-base text-xmr-green font-mono p-6 relative">
        <div className="w-full max-w-md space-y-8 relative z-10 animate-in fade-in zoom-in-95 duration-300">
           <div className="text-center space-y-4">
              <PlusCircle size={48} className="mx-auto text-xmr-green" />
              <h1 className="text-3xl font-black italic uppercase text-xmr-green">New_Identity</h1>
              <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Define a label for your isolated cryptographic vault.</p>
           </div>
           <Card className="p-8">
              <form onSubmit={(e) => { e.preventDefault(); if(newName) setStep('MODE'); }} className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[9px] font-black text-xmr-dim uppercase">Identity_Label</label>
                    <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. PRIMARY_VAULT" className="w-full bg-xmr-base border border-xmr-border p-4 text-xl font-black text-xmr-green focus:border-xmr-green outline-none" />
                 </div>
                 <div className="flex gap-4">
                    {!isInitialSetup && <button type="button" onClick={() => setStep('AUTH')} className="flex-1 py-4 border border-xmr-border text-xmr-dim font-black uppercase text-[10px] hover:text-xmr-green transition-all cursor-pointer">Cancel</button>}
                    <button type="submit" className="flex-[2] py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-white hover:text-black transition-all cursor-pointer">Continue</button>
                 </div>
              </form>
           </Card>
        </div>
      </div>
    );
  }

  if (step === 'MODE') {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-xmr-base text-xmr-green font-mono p-6 relative">
        <div className="w-full max-w-md space-y-8 relative z-10 animate-in fade-in zoom-in-95 duration-300">
           <div className="text-center space-y-4">
              <h1 className="text-3xl font-black italic uppercase text-xmr-green">Setup_Strategy</h1>
              <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Deployment method for identity: <span className="text-xmr-green font-bold">{newName}</span></p>
           </div>
           <div className="grid grid-cols-1 gap-4">
              <button onClick={() => setStep('NEW_PASSWORD')} className="p-6 border border-xmr-border bg-xmr-green/5 hover:border-xmr-green hover:bg-xmr-green/10 transition-all text-left group cursor-pointer">
                 <div className="flex items-center gap-3 mb-2">
                    <Sparkles className="text-xmr-green group-hover:animate-pulse" size={20} />
                    <span className="text-sm font-black uppercase text-xmr-green">Generate_New_Vault</span>
                 </div>
                 <p className="text-[9px] text-xmr-dim uppercase leading-relaxed">System will derive a fresh 25-word mnemonic phrase for you to archive.</p>
              </button>
              <button onClick={() => setStep('RESTORE')} className="p-6 border border-xmr-border bg-xmr-accent/5 hover:border-xmr-accent hover:bg-xmr-accent/10 transition-all text-left group cursor-pointer">
                 <div className="flex items-center gap-3 mb-2">
                    <Download className="text-xmr-accent group-hover:animate-bounce" size={20} />
                    <span className="text-sm font-black uppercase text-xmr-accent">Restore_From_Backup</span>
                 </div>
                 <p className="text-[9px] text-xmr-dim uppercase leading-relaxed">Reconstruct an existing identity using your private mnemonic seed.</p>
              </button>
              <button onClick={() => setStep('LABEL')} className="mt-4 text-[9px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> Back_To_Label</button>
           </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-xmr-base text-xmr-green font-mono p-6 relative overflow-hidden">
      <div className="fixed inset-0 scanline-overlay pointer-events-none z-50 opacity-[0.05]"></div>
      <div className="w-full max-w-md space-y-8 relative z-10 animate-in fade-in zoom-in-95 duration-500">
        <div className="text-center space-y-4">
          <div className="inline-block p-4 rounded-full bg-xmr-green/10 border border-xmr-green/20 mb-2">
            {step !== 'AUTH' ? <ShieldCheck size={48} className="text-xmr-green" /> : <Shield size={48} className={`text-xmr-green ${isProcessing ? 'animate-pulse' : ''}`} />}
          </div>
          <h1 className="text-3xl font-black italic uppercase text-xmr-green">{step === 'RESTORE' ? 'Identity_Recovery' : step === 'NEW_PASSWORD' ? 'Initialize_Security' : 'Vault_Authorization'}</h1>
          <div className="flex items-center justify-center gap-2 text-[10px] text-xmr-dim uppercase tracking-[0.2em]"><Users size={12} /><span>Target: <span className="text-xmr-green font-black">{newName || activeIdentity?.name || 'PRIMARY'}</span></span></div>
        </div>
        <Card topGradientAccentColor={step !== 'AUTH' ? 'xmr-green' : 'xmr-accent'} className="p-8">
          <form onSubmit={handleUnlockSubmit} className="space-y-6">
            {step === 'RESTORE' && (
              <div className="space-y-4 animate-in slide-in-from-top-2 duration-300">
                <div className="space-y-2">
                  <label className="text-[9px] font-black text-xmr-dim uppercase ml-1 flex justify-between"><span>Mnemonic_Seed (25 words)</span><span className="text-xmr-accent font-black">STANDARD_ONLY</span></label>
                  <textarea rows={3} value={restoreSeed} onChange={(e) => setRestoreSeed(e.target.value)} placeholder="word1 word2 ..." className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none resize-none" />
                </div>
                <div className="space-y-2">
                  <label className="text-[9px] font-black text-xmr-dim uppercase ml-1 flex items-center gap-2"><Calendar size={10} /> Optional_Restore_Height</label>
                  <input type="number" value={restoreHeight} onChange={(e) => setRestoreHeight(e.target.value)} placeholder="e.g. 3000000" className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-green outline-none" />
                </div>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">{step !== 'AUTH' ? 'Set_Vault_Password' : 'Enter_Vault_Password'}</label>
              <div className="relative">
                <input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" className="w-full bg-xmr-base border border-xmr-border p-4 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20" />
                <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-xmr-dim opacity-50" size={20} />
              </div>
            </div>
            {step !== 'AUTH' && (
              <div className="space-y-2 animate-in slide-in-from-top-2 duration-300">
                <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Confirm_Vault_Password</label>
                <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••••••" className="w-full bg-xmr-base border border-xmr-border p-4 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20" />
              </div>
            )}
            {error && <div className="p-3 bg-red-900/20 border border-red-600/50 text-red-500 text-[10px] font-black uppercase flex items-center gap-2 animate-shake"><Skull size={14} /> {error}</div>}
            {isProcessing && logs.length > 0 && (
              <div className="p-3 bg-xmr-green/5 border border-xmr-green/10 rounded-sm space-y-1 overflow-hidden">
                 {logs.slice(0, 3).map((log, i) => (<p key={i} className={`text-[8px] uppercase truncate font-black ${i === 0 ? 'text-xmr-green' : 'text-xmr-dim opacity-60'}`}>{'>'} {log}</p>))}
              </div>
            )}
            <button disabled={isProcessing || !password || (step !== 'AUTH' && !confirmPassword)} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.3em] hover:bg-white hover:text-black transition-all flex items-center justify-center gap-3 group disabled:opacity-50 cursor-pointer">
              {isProcessing ? <><RefreshCw size={18} className="animate-spin" /> Authorizing...</> : <><Key size={18} className="group-hover:scale-110 transition-transform" />{step === 'RESTORE' ? 'Initiate_Recovery' : step === 'NEW_PASSWORD' ? 'Establish_Vault' : 'Unlock_Identity'}</>}
            </button>
            {step !== 'AUTH' && !isProcessing && <button type="button" onClick={() => setStep('MODE')} className="w-full text-[9px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> Back_To_Strategy</button>}
          </form>
          {step === 'AUTH' && !isProcessing && identities.length > 1 && (
            <div className="mt-8 pt-6 border-t border-xmr-border/20 space-y-3">
               <label className="text-[8px] font-black text-xmr-dim uppercase tracking-widest block text-center">Switch_Current_Identity</label>
               <div className="grid grid-cols-2 gap-2">
                  {identities.map(id => (<button key={id.id} type="button" onClick={() => onSwitchIdentity(id.id)} className={`px-3 py-2 text-[9px] font-black border uppercase transition-all flex items-center justify-between cursor-pointer ${id.id === activeId ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-xmr-border text-xmr-dim hover:border-xmr-green/50'}`}><span className="truncate pr-2">{id.name}</span>{id.id === activeId && <Check size={10} />}</button>))}
               </div>
            </div>
          )}
          {step === 'AUTH' && !isProcessing && <div className="mt-4 flex justify-center"><button type="button" onClick={() => setStep('LABEL')} className="text-[9px] text-xmr-dim hover:text-xmr-green flex items-center gap-2 uppercase font-black transition-all cursor-pointer"><PlusCircle size={12} /> Create_New_Identity</button></div>}
        </Card>
        <div className="text-center space-y-4">
          <p className="text-[8px] text-xmr-dim uppercase leading-relaxed max-w-xs mx-auto italic opacity-60">IMPORTANT: Password used to encrypt local keys.</p>
          {step === 'AUTH' && !isInitialSetup && <button onClick={() => onPurgeIdentity(activeId)} className="text-[8px] text-red-900 hover:text-red-500 uppercase font-black underline decoration-dotted underline-offset-4 transition-colors cursor-pointer">[ Nuclear_Identity_Purge ]</button>}
        </div>
      </div>
    </div>
  );
}
