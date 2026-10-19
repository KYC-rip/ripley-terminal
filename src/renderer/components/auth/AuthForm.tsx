import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Lock, Skull, RefreshCw, Key, Download, Sparkles, ArrowLeft, Calendar, Eye, AlertTriangle } from 'lucide-react';
import { moneroRestoreHeightFromDate } from '../../restoreHeight';
import { birthdayToDateInput } from '../../seedVerdict';
import { useSeedInspection } from './useSeedInspection';
import { WhereToFindHelp } from './WhereToFindHelp';

export type RestoreMode = 'phrase' | 'viewonly';

interface LogEntry {
  msg: string;
  timestamp: number;
}

interface AuthFormProps {
  step: 'WELCOME' | 'AUTH' | 'LABEL' | 'MODE' | 'RESTORE' | 'NEW_PASSWORD';
  setStep: (s: any) => void;
  isInitialSetup: boolean;
  /** No identities at all — the first screen is the Create / I-already-have-one choice. */
  firstRun?: boolean;

  // RESTORE has two tabs: recovery phrase, or a standard view-only import.
  restoreMode: RestoreMode; setRestoreMode: (m: RestoreMode) => void;
  viewAddress: string; setViewAddress: (v: string) => void;
  viewKey: string; setViewKey: (v: string) => void;
  
  // Form Values & Setters
  password: string; setPassword: (v: string) => void;
  confirmPassword: string; setConfirmPassword: (v: string) => void;
  restoreSeed: string; setRestoreSeed: (v: string) => void;
  restoreHeight: string; setRestoreHeight: (v: string) => void;
  newName: string; setNewName: (v: string) => void;
  /** Chain network from config ("mainnet" default) — the date estimate needs it. */
  network?: string;
  
  // State
  error: string;
  isProcessing: boolean;
  logs: LogEntry[];
  
  // Actions
  handleUnlockSubmit: (e: FormEvent) => void;
}

export function AuthForm({ 
  step, setStep, isInitialSetup, firstRun = false,
  restoreMode, setRestoreMode, viewAddress, setViewAddress, viewKey, setViewKey,
  password, setPassword, confirmPassword, setConfirmPassword,
  restoreSeed, setRestoreSeed, restoreHeight, setRestoreHeight,
  newName, setNewName,
  network,
  error, isProcessing, logs,
  handleUnlockSubmit
}: AuthFormProps) {
  const [walletDate, setWalletDate] = useState('');

  // Live verdict under the phrase box (debounced native inspect_seed; one call in flight).
  const seedCheck = useSeedInspection(step === 'RESTORE' && restoreMode === 'phrase' ? restoreSeed : '');

  /** Date → height through the one estimator (one week early; mainnet-only no-node anchor). */
  const applyWalletDate = (date: string) => {
    setWalletDate(date);
    const h = date ? moneroRestoreHeightFromDate(date, null, Date.now(), network) : null;
    // No estimate (e.g. stagenet, no node yet): clear any height from an earlier
    // date rather than submit one that no longer matches the chosen date.
    setRestoreHeight(h != null ? String(h) : '');
  };

  // A Polyseed carries its birthday: pre-fill Wallet_Created from it (still editable). Applied
  // once per detected birthday, so a later manual edit is not overwritten on every keystroke.
  // If the phrase then stops being that Polyseed (replaced by an older wallet's seed), the date it
  // filled in is dropped again — a too-LATE height silently misses funds — unless the user edited it.
  const appliedBirthday = useRef<number | null>(null);
  const autoDate = useRef<string | null>(null);
  const birthday = seedCheck.inspection && !seedCheck.inspection.error ? seedCheck.inspection.birthdayUnix ?? null : null;
  const settled = !seedCheck.pending;
  useEffect(() => {
    if (birthday) {
      if (birthday === appliedBirthday.current) return;
      appliedBirthday.current = birthday;
      const date = birthdayToDateInput(birthday);
      autoDate.current = date;
      applyWalletDate(date);
    } else if (settled && appliedBirthday.current !== null) {
      appliedBirthday.current = null;
      if (autoDate.current && walletDate === autoDate.current) applyWalletDate('');
      autoDate.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [birthday, settled]);

  if (step === 'WELCOME') {
    return (
      <div className="grid grid-cols-1 gap-3 animate-in fade-in duration-300">
        <button type="button" onClick={() => setStep('NEW_PASSWORD')} className="p-5 border border-xmr-border bg-xmr-green/5 hover:border-xmr-green hover:bg-xmr-green/10 transition-all text-left group cursor-pointer">
          <div className="flex items-center gap-3 mb-1"><Sparkles className="text-xmr-green" size={18} /><span className="text-sm font-black uppercase text-xmr-green">Create a new wallet</span></div>
          <p className="text-xs text-xmr-dim uppercase">New Monero wallet with a fresh 25-word seed.</p>
        </button>
        <button type="button" onClick={() => { setRestoreMode('phrase'); setStep('RESTORE'); }} className="p-5 border border-xmr-border bg-xmr-accent/5 hover:border-xmr-accent hover:bg-xmr-accent/10 transition-all text-left group cursor-pointer">
          <div className="flex items-center gap-3 mb-1"><Download className="text-xmr-accent" size={18} /><span className="text-sm font-black uppercase text-xmr-accent">I already have a Monero wallet</span></div>
          <p className="text-xs text-xmr-dim uppercase">Recovery phrase from Feather, Cake, GUI, Monerujo — or view-only keys.</p>
        </button>
      </div>
    );
  }

  if (step === 'LABEL') {
    return (
      <form onSubmit={(e) => { e.preventDefault(); if(newName) setStep('MODE'); }} className="space-y-4 animate-in fade-in duration-300">
         <div className="space-y-1">
            <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">Identity_Label</label>
            <input autoFocus type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. PRIMARY_VAULT" className="w-full bg-xmr-base border border-xmr-border p-3 text-lg font-black text-xmr-green outline-none focus:border-xmr-green transition-all" />
         </div>
         <button type="button" onClick={() => { if(newName) setStep('MODE'); }} disabled={!newName} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-white hover:text-black transition-all disabled:opacity-50 cursor-pointer">Next_Step</button>
      </form>
    );
  }

  if (step === 'MODE') {
    return (
      <div className="grid grid-cols-1 gap-3 animate-in fade-in duration-300">
         <button type="button" onClick={() => setStep('NEW_PASSWORD')} className="p-5 border border-xmr-border bg-xmr-green/5 hover:border-xmr-green hover:bg-xmr-green/10 transition-all text-left group">
            <div className="flex items-center gap-3 mb-1"><Sparkles className="text-xmr-green" size={18} /><span className="text-sm font-black uppercase text-xmr-green">Generate_New</span></div>
            <p className="text-xs text-xmr-dim uppercase">Derive fresh 25-word mnemonic phrase.</p>
         </button>
         <button type="button" onClick={() => { setRestoreMode('phrase'); setStep('RESTORE'); }} className="p-5 border border-xmr-border bg-xmr-accent/5 hover:border-xmr-accent hover:bg-xmr-accent/10 transition-all text-left group">
            <div className="flex items-center gap-3 mb-1"><Download className="text-xmr-accent" size={18} /><span className="text-sm font-black uppercase text-xmr-accent">Restore_Existing</span></div>
            <p className="text-xs text-xmr-dim uppercase">Import identity from private backup seed.</p>
         </button>
         <button type="button" onClick={() => { if(isInitialSetup) setStep('LABEL'); else setStep('AUTH'); }} className="mt-2 text-[11px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> Back</button>
      </div>
    );
  }

  return (
    <form onSubmit={handleUnlockSubmit} className="space-y-5 animate-in slide-in-from-bottom-2 duration-300">
      {step === 'RESTORE' && (
        <div className="space-y-3">
          {/* Two ways in: the wallet's recovery phrase, or its address + private view key. */}
          <div className="grid grid-cols-2 border border-xmr-border/50" role="tablist">
            {([['phrase', 'Recovery phrase'], ['viewonly', 'View-only']] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={restoreMode === m}
                onClick={() => setRestoreMode(m)}
                className={`py-2 text-[10px] font-black uppercase tracking-widest transition-all cursor-pointer ${restoreMode === m ? 'bg-xmr-green text-xmr-base' : 'text-xmr-dim hover:text-xmr-green'}`}
              >
                {label}
              </button>
            ))}
          </div>

          {restoreMode === 'phrase' ? (
            <div className="space-y-1">
              <label className="text-[11px] font-black text-xmr-dim uppercase ml-1 flex justify-between"><span>Recovery_Phrase</span><span className="text-xmr-accent font-black">25 / 24 / 16 WORDS</span></label>
              <textarea rows={3} value={restoreSeed} onChange={(e) => setRestoreSeed(e.target.value)} placeholder="word1 word2 ..." autoComplete="off" spellCheck={false} className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none resize-none" />
              {(seedCheck.verdict || seedCheck.pending) && (
                <div className="ml-1 space-y-0.5" aria-live="polite">
                  {seedCheck.pending ? (
                    <p className="text-[10px] font-black uppercase tracking-widest text-xmr-dim animate-pulse">Checking phrase…</p>
                  ) : seedCheck.verdict && (
                    <>
                      <p className={`text-[10px] font-black uppercase tracking-wide leading-snug ${seedCheck.verdict.tone === 'ok' ? 'text-xmr-green' : seedCheck.verdict.tone === 'error' ? 'text-xmr-error' : seedCheck.verdict.tone === 'warn' ? 'text-xmr-accent' : 'text-xmr-dim'}`}>
                        {seedCheck.verdict.text}
                      </p>
                      {seedCheck.verdict.addressLine && (
                        <p className="text-[10px] text-xmr-dim leading-snug break-all">{seedCheck.verdict.addressLine}</p>
                      )}
                      {seedCheck.inspection?.format === 'polyseed' && seedCheck.verdict.tone === 'ok' && (
                        <p className="text-[10px] text-xmr-dim/70 leading-snug">Ripley shows this wallet's 25-word seed — your Polyseed still restores it too.</p>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">Wallet_Name</label>
                <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. OLD_FEATHER" className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">Primary_Address</label>
                <textarea rows={2} value={viewAddress} onChange={(e) => setViewAddress(e.target.value)} placeholder="4..." autoComplete="off" spellCheck={false} className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none resize-none break-all" />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">Private_View_Key</label>
                <input type="password" value={viewKey} onChange={(e) => setViewKey(e.target.value)} placeholder="64 hex characters" autoComplete="off" spellCheck={false} className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none" />
              </div>
              <p className="text-[10px] text-xmr-accent leading-snug ml-1 flex gap-2">
                <Eye size={12} className="shrink-0 mt-px" />
                <span>View-only — sees incoming funds only. Spends made from your real wallet don't show here, so the balance can read higher than it really is.</span>
              </p>
            </div>
          )}

          <WhereToFindHelp mode={restoreMode} />

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[11px] font-black text-xmr-dim uppercase ml-1 flex items-center gap-2"><Calendar size={10} /> Restore_Height (Optional)</label>
              <input type="number" value={restoreHeight} onChange={(e) => setRestoreHeight(e.target.value)} placeholder="e.g. 3000000" className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none" />
            </div>
            {/* Was a Seed_Language picker the backend never read (it detects the language
                from the words). The wallet's creation date is what a restore actually needs. */}
            <div className="space-y-1">
              <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">Wallet_Created (Date)</label>
              <input
                type="date"
                min="2014-04-18"
                max={new Date().toISOString().slice(0, 10)}
                value={walletDate}
                onChange={(e) => applyWalletDate(e.target.value)}
                className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-green outline-none"
              />
            </div>
          </div>
          <p className="text-[10px] text-xmr-dim leading-snug ml-1">
            {restoreHeight
              ? (walletDate ? 'Height estimated from the date and moved one week earlier for safety. Earlier only scans more; later can miss funds.' : 'Scanning starts at this block height. Earlier only scans more; later can miss funds.')
              : walletDate
                ? 'Could not estimate a height for this date on this network — enter a block height, or leave it empty to scan from 2017.'
                : 'No date — Ripley scans from 2017. This can take hours, or days over Tor. Any date before the wallet\'s first transaction is safe; earlier only scans more.'}
          </p>

          {restoreMode === 'phrase' && (
            <p className="text-[10px] text-xmr-dim/80 leading-snug ml-1 flex gap-2">
              <AlertTriangle size={12} className="shrink-0 mt-px text-xmr-accent" />
              <span>Using the same seed in two wallets at once can show conflicting balances while a send is pending — close the old wallet or move the funds.</span>
            </p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">{step === 'AUTH' ? 'Vault_Secret' : 'Set_Master_Password'}</label>
        <div className="relative">
          <input autoFocus={step !== 'RESTORE'} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" className="w-full bg-xmr-base border border-xmr-border p-2 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20" />
          <Lock className="absolute right-4 top-1/2 -translate-y-1/2 text-xmr-dim opacity-30" size={20} />
        </div>
      </div>

      {step !== 'AUTH' && (
        <div className="space-y-1">
          <label className="text-[11px] font-black text-xmr-dim uppercase ml-1">Confirm_Password</label>
          <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} placeholder="••••••••••••" className="w-full bg-xmr-base border border-xmr-border p-2 text-xl font-black text-xmr-green focus:border-xmr-green outline-none transition-all placeholder:opacity-20" />
        </div>
      )}

      {error && <div className="p-3 bg-xmr-error/10 border border-xmr-error/50 text-xmr-error text-xs font-black uppercase flex items-center gap-2 animate-shake"><Skull size={14} /> {error}</div>}

      {isProcessing && logs.length > 0 && (
        <div className="p-3 bg-xmr-green/5 border border-xmr-green/10 rounded-sm space-y-1 overflow-hidden">
           {logs.slice(0, 3).map((log, i) => (
             <p key={i} className={`text-xs uppercase truncate font-black ${i === 0 ? 'text-xmr-green' : 'text-xmr-dim opacity-60'}`}>
               {'>'} {log.msg}
             </p>
           ))}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <button disabled={isProcessing || !password || (step !== 'AUTH' && !confirmPassword)} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.3em] hover:bg-white hover:text-black transition-all flex items-center justify-center gap-3 group disabled:opacity-50 cursor-pointer">
          {isProcessing ? <><RefreshCw size={18} className="animate-spin" /> Authorizing...</> : <><Key size={18} className="group-hover:scale-110 transition-transform" /> {step === 'RESTORE' ? (restoreMode === 'viewonly' ? 'Import View-Only' : 'Restore Wallet') : step === 'NEW_PASSWORD' ? 'Create Wallet' : 'Unlock'}</>}
        </button>

        {!isProcessing && step === 'NEW_PASSWORD' && isInitialSetup && (
           <button type="button" onClick={() => { setRestoreMode('phrase'); setStep('RESTORE'); }} className="w-full text-[11px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><Download size={12}/> Restore from Seed</button>
        )}
        {!isProcessing && step === 'NEW_PASSWORD' && firstRun && (
           <button type="button" onClick={() => setStep('WELCOME')} className="w-full text-[11px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> Back</button>
        )}
        {/* When existing wallets are present, EVERY setup step must offer an escape
            back to Unlock — otherwise a user who enters create/restore is stranded
            (and could accidentally CREATE a new empty wallet). */}
        {!isProcessing && step === 'NEW_PASSWORD' && !isInitialSetup && (
           <button type="button" onClick={() => setStep('AUTH')} className="w-full text-[11px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> Back to Unlock</button>
        )}
        {!isProcessing && step === 'RESTORE' && (
           <button type="button" onClick={() => setStep(firstRun ? 'WELCOME' : isInitialSetup ? 'MODE' : 'AUTH')} className="w-full text-[11px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> {firstRun || isInitialSetup ? 'Back' : 'Back to Unlock'}</button>
        )}
        {!isProcessing && step !== 'AUTH' && step !== 'NEW_PASSWORD' && step !== 'RESTORE' && step !== 'WELCOME' && (
           <button type="button" onClick={() => setStep(isInitialSetup ? 'MODE' : 'AUTH')} className="w-full text-[11px] text-xmr-dim hover:text-xmr-green uppercase flex items-center justify-center gap-2 transition-colors cursor-pointer"><ArrowLeft size={12}/> {isInitialSetup ? 'Back' : 'Back to Unlock'}</button>
        )}
      </div>
    </form>
  );
}
