import React, { useState } from 'react';
import { Lock, Shield, Skull, RefreshCw, Key, Users, PlusCircle, Check, ShieldCheck, Download, Sparkles, ArrowLeft, Calendar, ChevronDown, ChevronUp, Trash2, Globe, ShieldAlert } from 'lucide-react';
import { Card } from './Card';
import { AuthForm } from './auth/AuthForm';
import { IdentitySwitcher } from './auth/IdentitySwitcher';
import { LogEntry } from '../contexts/VaultContext';
import { useTor } from '../contexts/TorContext';

interface Identity { id: string; name: string; created: number; }

interface AuthViewProps {
  onUnlock: (password: string, restoreSeed?: string, restoreHeight?: number, newIdentityName?: string) => void;
  isInitialSetup: boolean;
  identities: Identity[];
  activeId: string;
  onSwitchIdentity: (id: string) => void;
  onCreateIdentity: (name: string) => void;
  onPurgeIdentity: (id: string) => void;
  logs?: LogEntry[];
}

type SetupStep = 'AUTH' | 'LABEL' | 'MODE' | 'RESTORE' | 'NEW_PASSWORD';

export function AuthView({ onUnlock, isInitialSetup, identities, activeId, onSwitchIdentity, onCreateIdentity, onPurgeIdentity, logs = [] }: AuthViewProps) {
  const { useTor: torEnabled, setUseTor } = useTor();
  const [step, setStep] = useState<SetupStep>('AUTH');
  const [hasInitialized, setHasInitialized] = useState(false);

  // 🛡️ SYNC STEP WITH ASYNC DATA
  // When identities finally load from the IPC, we need to decide where to put the user.
  React.useEffect(() => {
    if (!hasInitialized && identities.length > 0) {
      if (isInitialSetup) setStep('MODE');
      else setStep('AUTH');
      setHasInitialized(true);
    } else if (!hasInitialized && identities.length === 0) {
      setStep('LABEL');
      // We don't setHasInitialized(true) here because we want to catch the transition when IDs arrive
    }
  }, [identities.length, isInitialSetup, hasInitialized]);
  
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
    if (step === 'RESTORE' || step === 'NEW_PASSWORD' || (step === 'LABEL' && isInitialSetup)) {
      if (password.length < 8) { setError('SECRET_TOO_SHORT: MIN 8 CHARS'); return; }
      if (password !== confirmPassword) { setError('PASSWORDS_DO_NOT_MATCH'); return; }
    }
    setIsProcessing(true);
    setError('');
    setTimeout(async () => {
      try {
        const height = restoreHeight ? parseInt(restoreHeight) : undefined;
        // If we are in any step other than AUTH, we are creating/initializing
        const nameToUse = (step !== 'AUTH' && !isInitialSetup) ? newName : undefined;
        await onUnlock(password, step === 'RESTORE' ? restoreSeed : undefined, height, nameToUse);
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
            {step === 'RESTORE' ? 'Identity_Recovery' : step === 'NEW_PASSWORD' ? 'Initialize_Vault' : (identities.length === 0 || step === 'LABEL') ? 'New_Tactical_ID' : 'Vault_Authorization'}
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
            handleCreateFinalize={() => {}}
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

          {/* 🛡️ TACTICAL NETWORK TOGGLE: Allows disabling Tor before login */}
          {!isProcessing && (
            <div className="mt-6 pt-4 border-t border-xmr-border/10 flex justify-between items-center">
              <div className="flex items-center gap-2">
                {torEnabled ? <ShieldCheck size={12} className="text-xmr-green" /> : <Globe size={12} className="text-xmr-accent" />}
                <span className="text-[8px] font-black uppercase tracking-widest text-xmr-dim">Uplink_Strategy</span>
              </div>
              <button 
                type="button"
                onClick={() => setUseTor(!torEnabled)} 
                className={`px-2 py-0.5 rounded border text-[8px] font-black transition-all cursor-pointer ${
                  torEnabled 
                    ? 'border-xmr-green/50 text-xmr-green hover:bg-xmr-green/10' 
                    : 'border-xmr-accent/50 text-xmr-accent hover:bg-xmr-accent/10'
                }`}
              >
                {torEnabled ? 'TOR_ONLY' : 'CLEARNET_ACTIVE'}
              </button>
            </div>
          )}
        </Card>

        {/* FOOTER ACTIONS */}
        <div className="text-center space-y-4 pt-4">
          <p className="text-[8px] text-xmr-dim uppercase leading-relaxed max-w-md mx-auto opacity-60 italic">
            IMPORTANT: Local password is the only key to decrypt your vault file. <br/>
            Zero-knowledge isolation active.
          </p>
          {step === 'AUTH' && identities.length > 0 && (
            <button onClick={() => onPurgeIdentity(activeId)} className="text-[8px] text-red-900 hover:text-red-500 uppercase font-black underline decoration-dotted underline-offset-4 transition-colors cursor-pointer flex items-center justify-center gap-2 mx-auto">
               [ Nuclear_Identity_Purge ]
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
