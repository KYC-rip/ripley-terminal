import React, { useState, useRef } from 'react';
import { X, Send, Ghost } from 'lucide-react';
import { useVault } from '../../contexts/VaultContext';
import { DispatchPasswordGate } from './DispatchPasswordGate';
import { DirectSendTab } from './DirectSendTab';
import { GhostSendTab } from './GhostSendTab';

interface DispatchModalProps {
  onClose: () => void;
  initialAddress?: string;
  sourceSubaddressIndex?: number;
}

type Tab = 'direct' | 'ghost';

export function DispatchModal({ onClose, initialAddress = '', sourceSubaddressIndex }: DispatchModalProps) {
  const { activeId, outputs } = useVault();
  const [tab, setTab] = useState<Tab>('direct');

  // --- Password Confirmation ---
  const [showPasswordGate, setShowPasswordGate] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null);

  const requirePassword = (action: () => Promise<void>) => {
    pendingActionRef.current = action;
    setPassword('');
    setPasswordError('');
    setShowPasswordGate(true);
  };

  const verifyAndExecute = async () => {
    if (!password) return;
    setIsVerifying(true);
    setPasswordError('');
    try {
      const res = await window.api.walletAction('open', { name: activeId, pwd: password });
      if (!res.success) throw new Error(res.error || 'Invalid password');
      setShowPasswordGate(false);
      if (pendingActionRef.current) await pendingActionRef.current();
    } catch (e: any) {
      setPasswordError(e.message?.includes('invalid password') ? 'WRONG_PASSWORD' : e.message || 'Verification failed');
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-xmr-base/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
      <div className="w-full max-w-xl bg-xmr-surface border border-xmr-border relative flex flex-col max-h-[85vh] overflow-hidden">
        {/* ══ PASSWORD GATE ══ */}
        {showPasswordGate && (
          <DispatchPasswordGate
            password={password}
            passwordError={passwordError}
            isVerifying={isVerifying}
            onPasswordChange={(val) => {
              setPassword(val);
              setPasswordError('');
            }}
            onVerify={verifyAndExecute}
            onCancel={() => setShowPasswordGate(false)}
          />
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-xmr-border/40">
          <div>
            <h3 className="text-lg font-black italic uppercase text-xmr-accent tracking-tight">Dispatch_Sequence</h3>
            <p className="text-[11px] text-xmr-dim uppercase tracking-widest mt-0.5">
              {sourceSubaddressIndex !== undefined ? `Source: Subaddress #${sourceSubaddressIndex}` : 'Outbound transfer'}
            </p>
          </div>
          <button onClick={onClose} className="text-xmr-dim hover:text-xmr-accent transition-colors cursor-pointer p-1">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-xmr-border/30">
          {[
            { id: 'direct' as const, label: 'Direct XMR', icon: <Send size={12} /> },
            { id: 'ghost' as const, label: 'Ghost Send', icon: <Ghost size={12} /> },
          ].map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2.5 text-[11px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                tab === t.id
                  ? 'text-xmr-accent border-b-2 border-xmr-accent bg-xmr-accent/5'
                  : 'text-xmr-dim hover:text-xmr-accent/70'
              }`}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-5">
          {tab === 'direct' && (
            <DirectSendTab
              initialAddress={initialAddress}
              sourceSubaddressIndex={sourceSubaddressIndex}
              outputs={outputs}
              onRequirePassword={requirePassword}
              onClose={onClose}
            />
          )}

          {tab === 'ghost' && <GhostSendTab onRequirePassword={requirePassword} onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}
