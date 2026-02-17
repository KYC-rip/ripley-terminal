import React, { useState } from 'react';
import { Shield, ShieldCheck, Users } from 'lucide-react';
import { Card } from './Card';
import { AuthForm } from './auth/AuthForm';
import { IdentitySwitcher } from './auth/IdentitySwitcher';

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

  const handleCreateFinalize = () => {
    // This is for generating new seed, handled by handleUnlockSubmit with mode
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
          <AuthForm 
            step={step} setStep={setStep} isInitialSetup={isInitialSetup}
            password={password} setPassword={setPassword}
            confirmPassword={confirmPassword} setConfirmPassword={setConfirmPassword}
            restoreSeed={restoreSeed} setRestoreSeed={setRestoreSeed}
            restoreHeight={restoreHeight} setRestoreHeight={setRestoreHeight}
            newName={newName} setNewName={setNewName}
            error={error} isProcessing={isProcessing} logs={logs}
            handleUnlockSubmit={handleUnlockSubmit}
            handleCreateFinalize={handleCreateFinalize}
          />

          {!isProcessing && step === 'AUTH' && (
            <IdentitySwitcher 
              identities={identities} 
              activeId={activeId} 
              onSwitchIdentity={onSwitchIdentity}
              onStartNew={() => setStep('LABEL')}
              onPurge={onPurgeIdentity}
            />
          )}
        </Card>

        {/* FOOTER ACTIONS */}
        <div className="text-center space-y-4 pt-4">
          <p className="text-[8px] text-xmr-dim uppercase leading-relaxed max-w-xs mx-auto opacity-60 italic">
            IMPORTANT: Local password is the only key to decrypt your vault file.
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
