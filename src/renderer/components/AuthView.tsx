import React, { useState, useEffect } from 'react';
import { Shield, ShieldCheck, Users, Globe, ShieldAlert } from 'lucide-react';
import { Card } from './Card';
import { AuthForm } from './auth/AuthForm';
import { IdentitySwitcher } from './auth/IdentitySwitcher';
import { LogEntry } from '../contexts/VaultContext';

interface Identity { id: string; name: string; created: number; }

interface AuthViewProps {
  onUnlock: (password: string, newIdentityName?: string, restoreSeed?: string, restoreHeight?: number, seedLanguage?: string) => Promise<void>;
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
  const [routingMode, setRoutingMode] = useState<'tor' | 'clearnet'>('tor');
  const [step, setStep] = useState<SetupStep>('AUTH');
  const [hasInitialized, setHasInitialized] = useState(false);

  useEffect(() => {
    // Load initial network mode
    window.api.getConfig().then((config: any) => {
      setRoutingMode(config.routingMode || 'tor');
    });

  // Handle step transition after identity load
    if (!hasInitialized && identities.length > 0) {
      setStep('AUTH');
      setHasInitialized(true);
    } else if (!hasInitialized && identities.length === 0) {
      setStep('LABEL');
    }
  }, [identities.length, hasInitialized]);

  // 🟢 2. Handle network toggle (persist directly to main process)
  const toggleNetwork = async () => {
    const newMode = routingMode === 'tor' ? 'clearnet' : 'tor';
    setRoutingMode(newMode);

    const config = await window.api.getConfig();
    await window.api.saveConfigAndReload({
      ...config,
      routingMode: newMode
    });
  };

  // Form States
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [restoreSeed, setRestoreSeed] = useState('');
  const [restoreHeight, setRestoreHeight] = useState('');
  const [newName, setNewName] = useState('');
  const [seedLanguage, setSeedLanguage] = useState('English');
  const [error, setError] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);

  const activeIdentity = identities.find(i => i.id === activeId) || identities[0];

  const handleIdentityChange = (id: string) => {
    if (isProcessing) return;
    setError('');
    setPassword('');
    setConfirmPassword('');
    onSwitchIdentity(id);
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isProcessing) return;

    // Validation logic
    if (step === 'RESTORE' || step === 'NEW_PASSWORD' || (step === 'LABEL' && isInitialSetup)) {
      if (password.length < 8) { setError('SECRET_TOO_SHORT: MIN 8 CHARS'); return; }
      if (password !== confirmPassword) { setError('PASSWORDS_DO_NOT_MATCH'); return; }
    }

    setIsProcessing(true);
    setError('');

    try {
      const height = restoreHeight ? parseInt(restoreHeight) : undefined;
      // 🚀 Call the new unlock in VaultContext
      await onUnlock(
        password,
        newName || undefined,
        step === 'RESTORE' ? restoreSeed : undefined,
        height,
        step === 'RESTORE' ? seedLanguage : undefined
      );
    } catch (err: any) {
      const msg = err.message || '';
      if (msg.includes('INVALID_SECRET')) setError('ACCESS_DENIED: WRONG PASSWORD');
      else if (msg.includes('UPLINK_TIMEOUT')) setError('UPLINK_TIMEOUT: TOR CIRCUIT FAILED');
      else setError(`ENGINE_ERROR: ${msg.toUpperCase()}`);
      setIsProcessing(false);
    }
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
          <div className="flex items-center justify-center gap-2 text-[11px] text-xmr-dim uppercase tracking-widest">
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
            seedLanguage={seedLanguage} setSeedLanguage={setSeedLanguage}
            error={error} isProcessing={isProcessing} logs={logs}
            handleUnlockSubmit={handleUnlockSubmit}
            handleCreateFinalize={() => { }}
          />

          {!isProcessing && step === 'AUTH' && (
            <IdentitySwitcher
              identities={identities}
              activeId={activeId}
              onSwitchIdentity={handleIdentityChange}
              onStartNew={() => {
                setNewName('');  // Clear input
                setStep('LABEL'); // Jump to new label setup step
              }}
              onPurge={onPurgeIdentity}
            />
          )}

          {/* 🛡️ TACTICAL NETWORK TOGGLE: Direct control of main process RoutingMode */}
          {!isProcessing && (
            <div className="mt-6 pt-4 border-t border-xmr-border/10 flex justify-between items-center">
              <div className="flex items-center gap-2">
                {routingMode === 'tor' ? <ShieldCheck size={12} className="text-xmr-green" /> : <Globe size={12} className="text-xmr-accent" />}
                <span className="text-xs font-black uppercase tracking-widest text-xmr-dim">Uplink_Strategy</span>
              </div>
              <button
                type="button"
                onClick={toggleNetwork}
                className={`px-2 py-0.5 rounded border text-xs font-black transition-all cursor-pointer ${routingMode === 'tor'
                  ? 'border-xmr-green/50 text-xmr-green hover:bg-xmr-green/10'
                  : 'border-xmr-accent/50 text-xmr-accent hover:bg-xmr-accent/10'
                  }`}
              >
                {routingMode === 'tor' ? 'TOR_ONLY' : 'CLEARNET_ACTIVE'}
              </button>
            </div>
          )}
        </Card>

        {/* FOOTER */}
        <div className="text-center space-y-4 pt-4">
          <p className="text-xs text-xmr-dim uppercase leading-relaxed max-w-md mx-auto opacity-60 italic">
            IMPORTANT: Local password is the only key to decrypt your vault file. <br />
            Zero-knowledge isolation active.
          </p>
        </div>
      </div>
    </div>
  );
}