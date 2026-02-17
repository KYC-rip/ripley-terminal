import React, { useState } from 'react';
import { Lock, Shield, Skull, RefreshCw, Key, Users, PlusCircle, Check, ShieldCheck } from 'lucide-react';
import { Card } from './Card';

interface Identity {
  id: string;
  name: string;
  created: number;
}

interface AuthViewProps {
  onUnlock: (password: string) => void;
  isInitialSetup: boolean;
  identities: Identity[];
  activeId: string;
  onSwitchIdentity: (id: string) => void;
  onCreateIdentity: (name: string) => void;
}

export function AuthView({ onUnlock, isInitialSetup, identities, activeId, onSwitchIdentity, onCreateIdentity }: AuthViewProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');

  const activeIdentity = identities.find(i => i.id === activeId) || identities[0];

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) return;
    
    if (isInitialSetup) {
      if (password.length < 8) {
        setError('SECRET_TOO_SHORT: MIN 8 CHARS');
        return;
      }
      if (password !== confirmPassword) {
        setError('PASSWORDS_DO_NOT_MATCH');
        return;
      }
    }

    setIsProcessing(true);
    setError('');
    
    setTimeout(async () => {
      try {
        await onUnlock(password);
      } catch (err: any) {
        setError(err.message === 'INVALID_SECRET' ? 'ACCESS_DENIED: WRONG PASSWORD' : err.message);
        setIsProcessing(false);
      }
    }, 800);
  };

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName) return;
    onCreateIdentity(newName);
  };

  if (showCreate) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-xmr-base text-xmr-green font-mono p-6 relative">
        <div className="w-full max-w-md space-y-8 relative z-10 animate-in fade-in zoom-in-95 duration-300">
           <div className="text-center space-y-4">
              <div className="inline-block p-4 rounded-full bg-xmr-green/10 border border-xmr-green/20 mb-2">
                <PlusCircle size={48} className="text-xmr-green" />
              </div>
              <h1 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-black">Register_Identity</h1>
              <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Define a label for your new isolated cryptographic vault.</p>
           </div>
           <Card className="p-8">
              <form onSubmit={handleCreate} className="space-y-6">
                 <div className="space-y-2">
                    <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Identity_Label</label>
                    <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. PRIMARY_VAULT" className="w-full bg-xmr-base border border-xmr-border p-4 text-xl font-black text-xmr-green focus:border-xmr-green outline-none" />
                 </div>
                 <div className="flex gap-4">
                    <button type="button" onClick={() => setShowCreate(false)} className="flex-1 py-4 border border-xmr-border text-xmr-dim font-black uppercase text-[10px] hover:text-xmr-green transition-all cursor-pointer">Cancel</button>
                    <button type="submit" className="flex-[2] py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-white hover:text-black transition-all cursor-pointer">Next_Step</button>
                 </div>
              </form>
           </Card>
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
            {isInitialSetup ? (
              <ShieldCheck size={48} className="text-xmr-green" />
            ) : (
              <Shield size={48} className={`text-xmr-green ${isProcessing ? 'animate-pulse' : ''}`} />
            )}
          </div>
          <h1 className="text-3xl font-black italic uppercase tracking-tighter text-xmr-green font-black">
            {isInitialSetup ? 'Initialize_Security' : 'Vault_Authorization'}
          </h1>
          <div className="flex items-center justify-center gap-2 text-[10px] text-xmr-dim uppercase tracking-[0.2em]">
             <Users size={12} />
             <span>Target: <span className="text-xmr-green font-black">{activeIdentity?.name || 'PRIMARY'}</span></span>
          </div>
        </div>

        <Card topGradientAccentColor={isInitialSetup ? 'xmr-green' : 'xmr-accent'} className="p-8">
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">
                {isInitialSetup ? 'Create_Master_Password' : 'Enter_Vault_Password'}
              </label>
              <div className="relative">
                <input 
                  autoFocus
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-xmr-base border border-xmr-border p-4 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20"
                />
                <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-xmr-dim opacity-50" size={20} />
              </div>
            </div>

            {isInitialSetup && (
              <div className="space-y-2 animate-in slide-in-from-top-2 duration-300">
                <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Confirm_Master_Password</label>
                <input 
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="••••••••••••"
                  className="w-full bg-xmr-base border border-xmr-border p-4 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20"
                />
              </div>
            )}

            {error && (
              <div className="p-3 bg-red-900/20 border border-red-600/50 text-red-500 text-[10px] font-black uppercase flex items-center gap-2">
                <Skull size={14} /> {error}
              </div>
            )}

            <button 
              disabled={isProcessing || !password || (isInitialSetup && !confirmPassword)}
              className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.3em] hover:bg-white hover:text-black transition-all flex items-center justify-center gap-3 group disabled:opacity-50 cursor-pointer"
            >
              {isProcessing ? (
                <>
                  <RefreshCw size={18} className="animate-spin" />
                  Authorizing...
                </>
              ) : (
                <>
                  <Key size={18} className="group-hover:scale-110 transition-transform" />
                  {isInitialSetup ? 'Establish_Vault' : 'Unlock_Identity'}
                </>
              )}
            </button>
          </form>

          {/* Identity Switcher */}
          {!isProcessing && identities.length > 1 && (
            <div className="mt-8 pt-6 border-t border-xmr-border/20 space-y-3">
               <label className="text-[8px] font-black text-xmr-dim uppercase tracking-widest block text-center">Switch_Current_Identity</label>
               <div className="grid grid-cols-2 gap-2">
                  {identities.map(id => (
                    <button 
                      key={id.id}
                      type="button"
                      onClick={() => onSwitchIdentity(id.id)}
                      className={`px-3 py-2 text-[9px] font-black border uppercase transition-all flex items-center justify-between cursor-pointer ${id.id === activeId ? 'border-xmr-green text-xmr-green bg-xmr-green/5' : 'border-xmr-border text-xmr-dim hover:border-xmr-green/50'}`}
                    >
                      <span className="truncate pr-2">{id.name}</span>
                      {id.id === activeId && <Check size={10} />}
                    </button>
                  ))}
               </div>
            </div>
          )}

          {!isProcessing && (
            <div className="mt-4 flex justify-center">
               <button 
                 type="button"
                 onClick={() => setShowCreate(true)}
                 className="text-[9px] text-xmr-dim hover:text-xmr-green flex items-center gap-2 uppercase font-black transition-all cursor-pointer"
               >
                 <PlusCircle size={12} /> Create_New_Identity
               </button>
            </div>
          )}
        </Card>

        <div className="text-center">
          <p className="text-[8px] text-xmr-dim uppercase leading-relaxed max-w-xs mx-auto">
            IMPORTANT: Password used to encrypt local keys. <br/>
            If lost, the vault cannot be recovered without seed backup.
          </p>
        </div>
      </div>
    </div>
  );
}
