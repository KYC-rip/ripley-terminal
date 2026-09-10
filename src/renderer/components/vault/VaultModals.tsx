import { useState, useEffect } from 'react';
import { X, ShieldAlert, Copy, Check, Eye, EyeOff } from 'lucide-react';
import type { WalletKeys } from '../../window';
import { ReceiveModal } from './ReceiveModal';
import { DispatchModal } from './DispatchModal';
import { SplinterModal } from './SplinterModal';
import { ChurnModal } from './ChurnModal';

interface VaultModalsProps {
  // Seed Modal
  showSeed: boolean;
  onCloseSeed: () => void;
  mnemonic: string;
  walletKeys?: WalletKeys | null;
  
  // Receive Modal
  showReceive: boolean;
  onCloseReceive: () => void;
  onCreateSub: (label: string) => void;
  selectedSubaddress?: { address: string; label: string; index: number } | null;
  
  // Send Modal
  showSend: boolean;
  onCloseSend: () => void;
  onSend: (address: string, amount: number) => void;
  isSending: boolean;
  initialAddr?: string;
  sourceSubaddressIndex?: number;

  // Splinter & Churn Modals
  showSplinter: boolean;
  onCloseSplinter: () => void;
  onSplinter: (fragments: number) => Promise<void>;

  showChurn: boolean;
  onCloseChurn: () => void;
  onChurn: () => Promise<void>;
  unlockedBalance: number;
}

export function VaultModals({ 
  showSeed, onCloseSeed, mnemonic, walletKeys = null,
  showReceive, onCloseReceive, onCreateSub, selectedSubaddress,
  showSend, onCloseSend, onSend, isSending,
  initialAddr = '', sourceSubaddressIndex,
  showSplinter, onCloseSplinter, onSplinter,
  showChurn, onCloseChurn, onChurn, unlockedBalance
}: VaultModalsProps) {

  return (
    <>
      {/* SEED MODAL */}
      {showSeed && (
        <div className="fixed top-0 bottom-0 right-0 left-[14rem] z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-2xl max-h-full overflow-y-auto bg-xmr-surface p-8 border-2 border-xmr-error/50 relative rounded-sm">
            <button onClick={onCloseSeed} className="absolute top-4 right-4 text-xmr-dim hover:text-xmr-error cursor-pointer"><X size={24} /></button>
            <div className="space-y-6 font-black">
              <div className="flex items-center gap-3 text-xmr-error animate-pulse font-black"><ShieldAlert size={32} /><h3 className="text-2xl font-black uppercase tracking-tighter">Backup_Protocol</h3></div>
              {mnemonic ? (
                <div className="p-4 bg-xmr-base border border-xmr-error/20 rounded-sm font-black text-sm leading-loose select-text text-xmr-green">{mnemonic}</div>
              ) : walletKeys?.viewOnly ? (
                <div className="p-4 bg-xmr-base border border-xmr-dim/20 rounded-sm text-xs text-xmr-dim uppercase tracking-widest">Watch-only vault — no seed or private spend key exists here.</div>
              ) : null}
              {walletKeys && <NativeKeys keys={walletKeys} />}
              <button onClick={onCloseSeed} className="w-full py-4 bg-xmr-error text-xmr-base font-black uppercase tracking-[0.2em] font-mono cursor-pointer hover:brightness-110 transition-all">I_HAVE_SECURED_THE_KEY</button>
            </div>
          </div>
        </div>
      )}

      {/* RECEIVE MODAL */}
      {showReceive && (
        <ReceiveModal
          onClose={onCloseReceive}
          existingAddress={selectedSubaddress || undefined}
        />
      )}

      {/* DISPATCH MODAL */}
      {showSend && (
        <DispatchModal
          onClose={onCloseSend}
          initialAddress={initialAddr}
          sourceSubaddressIndex={sourceSubaddressIndex}
        />
      )}

      {/* SPLINTER MODAL */}
      {showSplinter && (
        <SplinterModal
          onClose={onCloseSplinter}
          onSplinter={onSplinter}
          unlockedBalance={unlockedBalance}
        />
      )}

      {/* CHURN MODAL */}
      {showChurn && (
        <ChurnModal
          onClose={onCloseChurn}
          onChurn={onChurn}
          unlockedBalance={unlockedBalance}
        />
      )}
    </>
  );
}

// ── Native key rows (public/private view + spend, primary address) with copy buttons.
// The private spend key is masked until explicitly shown — it is the seed in hex.
function KeyRow({ label, value, secret, danger }: { label: string; value: string; secret?: boolean; danger?: boolean }) {
  const [shown, setShown] = useState(!secret);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!copied) return; const t = setTimeout(() => setCopied(false), 1500); return () => clearTimeout(t); }, [copied]);
  const copy = () => { navigator.clipboard.writeText(value); setCopied(true); };
  return (
    <div className={`p-3 bg-xmr-base border rounded-sm ${danger ? 'border-xmr-error/30' : 'border-xmr-dim/20'}`}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={`text-[10px] uppercase tracking-widest ${danger ? 'text-xmr-error' : 'text-xmr-dim'}`}>{label}</span>
        <span className="flex items-center gap-2">
          {secret && (
            <button onClick={() => setShown(v => !v)} className="text-xmr-dim hover:text-xmr-accent cursor-pointer" title={shown ? 'Hide' : 'Show'}>
              {shown ? <EyeOff size={12} /> : <Eye size={12} />}
            </button>
          )}
          <button onClick={copy} className="text-xmr-dim hover:text-xmr-accent cursor-pointer" title="Copy">
            {copied ? <Check size={12} className="text-xmr-green" /> : <Copy size={12} />}
          </button>
        </span>
      </div>
      <code className={`block font-mono text-[11px] break-all select-text ${danger ? 'text-xmr-error' : 'text-xmr-green'}`}>
        {shown ? value : '•'.repeat(64)}
      </code>
    </div>
  );
}

function NativeKeys({ keys }: { keys: WalletKeys }) {
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-[0.3em] text-xmr-dim">Native_Keys{keys.viewOnly ? ' · WATCH_ONLY' : ''}{keys.restoreHeight > 0 ? ` · restore height ${keys.restoreHeight}` : ''}</div>
      <KeyRow label="Primary address" value={keys.address} />
      <KeyRow label="Public view key" value={keys.publicViewKey} />
      <KeyRow label="Private view key" value={keys.privateViewKey} />
      <KeyRow label="Public spend key" value={keys.publicSpendKey} />
      {keys.privateSpendKey && <KeyRow label="Private spend key — full control of funds" value={keys.privateSpendKey} secret danger />}
    </div>
  );
}
