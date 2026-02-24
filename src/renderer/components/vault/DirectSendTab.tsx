import React, { useState, useEffect, useRef } from 'react';
import { Wallet, DollarSign, Send, Loader2, CheckCircle2, ChevronDown, ChevronUp, Coins } from 'lucide-react';
import { useVault } from '../../contexts/VaultContext';

interface ParsedDest {
  address: string;
  amount: number;
}

function parseMultiSend(text: string): { destinations: ParsedDest[]; errors: string[] } {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const destinations: ParsedDest[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const parts = line.split(/[,\s]+/).filter(Boolean);
    if (parts.length < 2) {
      errors.push(`Line ${i + 1}: missing amount`);
      return;
    }
    const address = parts[0];
    const amount = parseFloat(parts[parts.length - 1]);
    if (!address.match(/^[48]/)) {
      errors.push(`Line ${i + 1}: invalid XMR address`);
      return;
    }
    if (isNaN(amount) || amount <= 0) {
      errors.push(`Line ${i + 1}: invalid amount`);
      return;
    }
    destinations.push({ address, amount });
  });
  return { destinations, errors };
}

interface DirectSendTabProps {
  initialAddress: string;
  sourceSubaddressIndex?: number;
  outputs: any[];
  onRequirePassword: (action: () => Promise<void>) => void;
  onClose: () => void;
}

export function DirectSendTab({
  initialAddress,
  sourceSubaddressIndex,
  outputs,
  onRequirePassword,
  onClose,
}: DirectSendTabProps) {
  const { sendXmr, sendMulti, isSending } = useVault();

  const [sendMode, setSendMode] = useState<'single' | 'multi'>('single');
  const [destAddr, setDestAddr] = useState(initialAddress);
  const [sendAmount, setSendAmount] = useState('');
  const [multiText, setMultiText] = useState('');
  const [isBanned, setIsBanned] = useState(false);
  const [directSent, setDirectSent] = useState(false);
  const [directTxHash, setDirectTxHash] = useState('');

  // --- Coin Control ---
  const [showCoinControl, setShowCoinControl] = useState(sourceSubaddressIndex !== undefined);
  const [selectedOutputs, setSelectedOutputs] = useState<Set<string>>(new Set());
  const availableOutputs = outputs.filter((o: any) => o.isUnlocked);

  // --- xmr.bio Resolver ---
  const [bioProfile, setBioProfile] = useState<any>(null);
  const [isResolvingBio, setIsResolvingBio] = useState(false);
  const [bioError, setBioError] = useState('');
  const resolveBioRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (sendMode !== 'single') {
      setBioProfile(null);
      setBioError('');
      return;
    }

    const val = destAddr.trim();
    if (val.length > 0 && val.length < 50 && !val.includes(' ') && !/^[48]/.test(val)) {
      if (resolveBioRef.current) clearTimeout(resolveBioRef.current);

      setIsResolvingBio(true);
      setBioError('');
      setBioProfile(null);

      const handle = val.startsWith('@') ? val.substring(1) : val;

      resolveBioRef.current = setTimeout(async () => {
        try {
          const res = await fetch(`https://api.xmr.bio/${handle}`);
          if (res.ok) {
            const data = await res.json();
            if (data.address) {
              setBioProfile(data);
            } else {
              setBioError('No address found for this user.');
            }
          } else {
            setBioError('User not found on xmr.bio');
          }
        } catch (e) {
          setBioError('Failed to contact xmr.bio');
        } finally {
          setIsResolvingBio(false);
        }
      }, 600);
    } else {
      setBioProfile(null);
      setBioError('');
      setIsResolvingBio(false);
      if (resolveBioRef.current) clearTimeout(resolveBioRef.current);
    }
  }, [destAddr, sendMode]);

  // Ban check
  useEffect(() => {
    if (sendMode === 'single' && destAddr.length > 30) {
      fetch(`https://api.kyc.rip/v1/tools/ban-list?address=${destAddr}`)
        .then((res) => res.json())
        .then((data: any) => setIsBanned(data.results && data.results.length > 0))
        .catch(() => setIsBanned(false));
    } else setIsBanned(false);
  }, [destAddr, sendMode]);

  const parsed = sendMode === 'multi' ? parseMultiSend(multiText) : { destinations: [], errors: [] };
  const multiTotal = parsed.destinations.reduce((sum, d) => sum + d.amount, 0);

  const toggleOutput = (keyImage: string) => {
    setSelectedOutputs((prev) => {
      const next = new Set(prev);
      next.has(keyImage) ? next.delete(keyImage) : next.add(keyImage);
      return next;
    });
  };

  const selectedTotal = availableOutputs
    .filter((o: any) => selectedOutputs.has(o.keyImage))
    .reduce((sum: number, o: any) => sum + parseFloat(o.amount || '0'), 0);

  const handleExecute = () => {
    if (sendMode === 'single') {
      if (!destAddr || !sendAmount || isBanned) return;
      onRequirePassword(async () => {
        const subIndices =
          selectedOutputs.size > 0 && sourceSubaddressIndex !== undefined ? [sourceSubaddressIndex] : undefined;
        if (subIndices) {
          await sendMulti([{ address: destAddr, amount: parseFloat(sendAmount) }], subIndices);
        } else {
          const txHash = await sendXmr(destAddr, parseFloat(sendAmount));
          if (txHash) setDirectTxHash(txHash);
        }
        setDirectSent(true);
      });
    } else {
      if (parsed.destinations.length === 0 || parsed.errors.length > 0) return;
      onRequirePassword(async () => {
        const subIndices = sourceSubaddressIndex !== undefined ? [sourceSubaddressIndex] : undefined;
        await sendMulti(parsed.destinations, subIndices);
        setDirectSent(true);
      });
    }
  };

  if (directSent) {
    return (
      <div className="py-12 flex flex-col items-center gap-4 text-center">
        <CheckCircle2 size={48} className="text-xmr-green" />
        <div className="text-sm uppercase text-xmr-green font-black">Transaction Dispatched</div>
        {directTxHash && <div className="text-[11px] font-mono text-xmr-dim break-all max-w-sm">{directTxHash}</div>}
        {sendMode === 'multi' && (
          <div className="text-[11px] text-xmr-dim">
            {parsed.destinations.length} recipients • {multiTotal.toFixed(4)} XMR total
          </div>
        )}
        <button
          onClick={onClose}
          className="mt-4 px-6 py-2 bg-xmr-green text-xmr-base text-xs uppercase tracking-widest cursor-pointer"
        >
          Close
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Mode Toggle */}
      <div className="flex gap-2">
        {(['single', 'multi'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setSendMode(m)}
            className={`flex-1 py-1.5 text-xs font-black uppercase tracking-widest border transition-all cursor-pointer ${
              sendMode === m
                ? 'border-xmr-accent text-xmr-accent bg-xmr-accent/5'
                : 'border-xmr-border text-xmr-dim hover:border-xmr-accent/50'
            }`}
          >
            {m === 'single' ? 'Single Send' : 'Multi-Send'}
          </button>
        ))}
      </div>

      {sendMode === 'single' ? (
        <>
          <div className="space-y-1.5">
            <div className="flex justify-between items-center">
              <label className="text-[11px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                <Wallet size={10} /> Destination
                {isResolvingBio && <Loader2 size={10} className="animate-spin text-xmr-accent ml-1" />}
              </label>
              {isBanned && <span className="text-xs text-red-500 animate-pulse uppercase">Intercepted</span>}
            </div>
            <input
              type="text"
              value={destAddr}
              onChange={(e) => setDestAddr(e.target.value)}
              placeholder="4... / 8... / @xbtoshi"
              className={`w-full bg-xmr-base border p-3 text-xs text-xmr-green focus:border-xmr-accent outline-none transition-colors ${
                isBanned ? 'border-red-600' : 'border-xmr-border'
              }`}
            />

            {/* xmr.bio Profile Card */}
            {bioProfile && (
              <div className="mt-2 p-3 border border-xmr-green/30 bg-xmr-green/5 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3">
                    {bioProfile.avatar && (
                      <img
                        src={bioProfile.avatar}
                        alt="Avatar"
                        className="w-10 h-10 rounded bg-black object-cover border border-xmr-green/30"
                      />
                    )}
                    <div>
                      <div className="text-xs font-black text-xmr-green flex items-center gap-2">
                        {bioProfile.display_name}
                      </div>
                      <div className="text-[10px] text-xmr-dim uppercase font-mono tracking-widest">
                        @{bioProfile.handle}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => {
                      setDestAddr(bioProfile.address);
                      setBioProfile(null);
                    }}
                    className="px-3 py-1.5 bg-xmr-green text-xmr-base text-[10px] font-black uppercase hover:bg-xmr-green/80 transition-colors cursor-pointer"
                  >
                    Use_Address
                  </button>
                </div>
                {bioProfile.bio && (
                  <div className="text-[10px] text-xmr-green/80 italic font-mono border-l-2 border-xmr-green/50 pl-2 leading-relaxed">
                    {bioProfile.bio}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="space-y-1.5">
            <label className="text-[11px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
              <DollarSign size={10} /> Amount (XMR)
            </label>
            <input
              type="number"
              value={sendAmount}
              onChange={(e) => setSendAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-xmr-base border border-xmr-border p-3 text-2xl font-black text-xmr-accent focus:border-xmr-accent outline-none"
            />
          </div>
        </>
      ) : (
        <div className="space-y-1.5">
          <label className="text-[11px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
            <Send size={10} /> Recipients (address, amount per line)
          </label>
          <textarea
            value={multiText}
            onChange={(e) => setMultiText(e.target.value)}
            placeholder={'4...address1, 0.5\n8...address2, 1.2\n4...address3, 0.05'}
            rows={5}
            className="w-full bg-xmr-base border border-xmr-border p-3 text-xs text-xmr-green focus:border-xmr-accent outline-none font-mono resize-y"
          />
          {parsed.destinations.length > 0 && (
            <div className="flex justify-between text-xs uppercase">
              <span className="text-xmr-green">{parsed.destinations.length} recipient(s)</span>
              <span className="text-xmr-accent">Total: {multiTotal.toFixed(6)} XMR</span>
            </div>
          )}
          {parsed.errors.length > 0 && (
            <div className="text-xs text-red-500 space-y-0.5">
              {parsed.errors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Advanced Coin Control ── */}
      <div className="border border-xmr-border/30 rounded-sm overflow-hidden">
        <button
          onClick={() => setShowCoinControl(!showCoinControl)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs text-xmr-dim uppercase tracking-widest hover:bg-xmr-green/5 transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-1.5">
            <Coins size={10} /> Coin Control {selectedOutputs.size > 0 && `(${selectedOutputs.size} selected)`}
          </span>
          {showCoinControl ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        </button>
        {showCoinControl && (
          <div className="border-t border-xmr-border/20 max-h-[150px] overflow-y-auto custom-scrollbar">
            {availableOutputs.length === 0 ? (
              <div className="px-3 py-4 text-xs text-xmr-dim text-center uppercase">
                No unlocked outputs available
              </div>
            ) : (
              <table className="w-full text-xs">
                <tbody>
                  {availableOutputs.map((o: any, i: number) => (
                    <tr
                      key={i}
                      onClick={() => toggleOutput(o.keyImage)}
                      className={`cursor-pointer transition-colors ${
                        selectedOutputs.has(o.keyImage) ? 'bg-xmr-accent/10' : 'hover:bg-xmr-green/5'
                      }`}
                    >
                      <td className="px-3 py-1.5 w-6">
                        <div
                          className={`w-3 h-3 border rounded-sm flex items-center justify-center ${
                            selectedOutputs.has(o.keyImage)
                              ? 'bg-xmr-accent border-xmr-accent'
                              : 'border-xmr-border'
                          }`}
                        >
                          {selectedOutputs.has(o.keyImage) && <CheckCircle2 size={8} className="text-xmr-base" />}
                        </div>
                      </td>
                      <td className="px-1 py-1.5 text-xmr-green font-black">{o.amount} XMR</td>
                      <td className="px-1 py-1.5 text-xmr-dim font-mono opacity-40">
                        {o.keyImage?.substring(0, 16)}...
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {selectedOutputs.size > 0 && (
              <div className="px-3 py-1.5 border-t border-xmr-border/20 text-xs flex justify-between text-xmr-accent uppercase">
                <span>Selected: {selectedOutputs.size} coins</span>
                <span>{selectedTotal.toFixed(6)} XMR</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end pt-2">
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.api.openPath('https://xmr.bio');
          }}
          className="text-[10px] text-xmr-dim hover:text-xmr-green underline transition-colors font-black tracking-widest"
        >
          CLAIM_XMR_BIO_PAGE
        </a>
      </div>

      <button
        disabled={
          isSending ||
          (sendMode === 'single'
            ? isBanned || !destAddr || !sendAmount
            : parsed.destinations.length === 0 || parsed.errors.length > 0)
        }
        onClick={handleExecute}
        className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-2 cursor-pointer ${
          isBanned && sendMode === 'single'
            ? 'bg-red-950 text-red-500 cursor-not-allowed'
            : 'bg-xmr-accent text-xmr-base hover:bg-xmr-green hover:text-xmr-base disabled:opacity-50 disabled:cursor-not-allowed'
        }`}
      >
        <Send size={18} />
        {isSending
          ? 'Dispatching...'
          : isBanned && sendMode === 'single'
          ? 'Mission_Aborted'
          : sendMode === 'multi'
          ? `Dispatch ${parsed.destinations.length} Transfers`
          : 'Confirm_Dispatch'}
      </button>
    </div>
  );
}
