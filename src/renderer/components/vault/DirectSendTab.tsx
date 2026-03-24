import React, { useState, useEffect, useRef } from 'react';
import { Wallet, DollarSign, Send, Loader2, CheckCircle2, ChevronDown, ChevronUp, Coins, Copy, AlertTriangle, ArrowLeft, Shield } from 'lucide-react';
import { useVault } from '../../contexts/VaultContext';
import { useStats } from '../../hooks/useStats';
import { WalletService } from '../../services/walletService';
import { useFiatValue } from '../../hooks/useFiatValue';

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

interface PreparedTx {
  fee: string;
  amount: string;
  txHash: string;
  txMetadata: string;
  destinations: { address: string; amount: string }[];
  isSweep?: boolean;
}

type Phase = 'input' | 'preparing' | 'confirm' | 'success';

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
  const {
    sendXmr, sendMulti, getFeeEstimates, isSending, balance,
    selectedAccountIndex, status, syncPercent,
    deepLinkData, clearDeepLinkData
  } = useVault();

  const [phase, setPhase] = useState<Phase>('input');
  const [sendMode, setSendMode] = useState<'single' | 'multi'>('single');
  const [destAddr, setDestAddr] = useState(initialAddress);
  const [sendAmount, setSendAmount] = useState('');
  const [multiText, setMultiText] = useState('');
  const [isBanned, setIsBanned] = useState(false);
  const [directTxHash, setDirectTxHash] = useState('');
  const [priority, setPriority] = useState(0);
  const [feeEstimates, setFeeEstimates] = useState<Record<number, string>>({});
  const [prepareError, setPrepareError] = useState('');
  const [preparedTx, setPreparedTx] = useState<PreparedTx | null>(null);
  const { stats } = useStats();

  // --- Coin Control ---
  const [showCoinControl, setShowCoinControl] = useState(sourceSubaddressIndex !== undefined);
  const [selectedOutputs, setSelectedOutputs] = useState<Set<string>>(new Set());
  const availableOutputs = outputs.filter((o: any) => o.isUnlocked);

  // --- xmr.bio Resolver ---
  const [bioProfile, setBioProfile] = useState<any>(null);
  const [isResolvingBio, setIsResolvingBio] = useState(false);
  const [bioError, setBioError] = useState('');
  const resolveBioRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fiat values for confirmation screen
  const totalXmr = preparedTx ? (parseFloat(preparedTx.amount) + parseFloat(preparedTx.fee)).toFixed(12).replace(/\.?0+$/, '') : '0';
  const { fiatText: feeFiat } = useFiatValue('XMR', preparedTx?.fee || '0', true);
  const { fiatText: amountFiat } = useFiatValue('XMR', preparedTx?.amount || '0', true);
  const { fiatText: totalFiat } = useFiatValue('XMR', totalXmr, true);

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

  // Deep Link Data
  useEffect(() => {
    if (deepLinkData) {
      if (deepLinkData.address) setDestAddr(deepLinkData.address);
      if (deepLinkData.amount) setSendAmount(deepLinkData.amount);
      setSendMode('single');
      clearDeepLinkData();
    }
  }, [deepLinkData, clearDeepLinkData]);

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

  const isFetchingFees = useRef(false);
  useEffect(() => {
    let timer: NodeJS.Timeout;
    const fetchFees = async () => {
      if (isFetchingFees.current) return;
      isFetchingFees.current = true;
      try {
        const result = await getFeeEstimates();
        if (result && result.fees) {
          const mapped: Record<number, string> = {
            1: result.fees[0],
            0: result.fees[1],
            2: result.fees[1],
            3: result.fees[2],
            4: result.fees[3]
          };
          setFeeEstimates(mapped);
        }
      } catch (e) {
        // silent fail
      } finally {
        isFetchingFees.current = false;
        timer = setTimeout(fetchFees, 10000);
      }
    };
    fetchFees();
    return () => clearTimeout(timer);
  }, [getFeeEstimates]);

  const selectedTotal = availableOutputs
    .filter((o: any) => selectedOutputs.has(o.keyImage))
    .reduce((sum: number, o: any) => sum + parseFloat(o.amount || '0'), 0);

  // ── PREPARE: construct tx without broadcasting ──
  const handlePrepare = async () => {
    setPrepareError('');

    if (sendMode === 'single') {
      const amount = parseFloat(sendAmount);
      if (!destAddr || isNaN(amount) || amount <= 0 || isBanned) return;

      const unlocked = parseFloat(balance.unlocked);
      if (amount > unlocked) {
        setPrepareError(`Insufficient funds: ${balance.unlocked} XMR unlocked, ${amount} XMR requested.`);
        return;
      }

      setPhase('preparing');
      try {
        const subIndices = selectedOutputs.size > 0 && sourceSubaddressIndex !== undefined
          ? [sourceSubaddressIndex] : undefined;

        const result = await WalletService.prepareTx(
          [{ address: destAddr, amount }],
          selectedAccountIndex, priority, subIndices
        );
        setPreparedTx(result);
        setPhase('confirm');
      } catch (e: any) {
        setPrepareError(e.message || 'Failed to prepare transaction');
        setPhase('input');
      }
    } else {
      if (parsed.destinations.length === 0 || parsed.errors.length > 0) return;

      const unlocked = parseFloat(balance.unlocked);
      if (multiTotal > unlocked) {
        setPrepareError(`Insufficient funds: total ${multiTotal.toFixed(6)} XMR exceeds ${balance.unlocked} XMR unlocked.`);
        return;
      }

      setPhase('preparing');
      try {
        const subIndices = sourceSubaddressIndex !== undefined ? [sourceSubaddressIndex] : undefined;
        const result = await WalletService.prepareTx(
          parsed.destinations, selectedAccountIndex, priority, subIndices
        );
        setPreparedTx(result);
        setPhase('confirm');
      } catch (e: any) {
        setPrepareError(e.message || 'Failed to prepare transaction');
        setPhase('input');
      }
    }
  };

  // ── SWEEP ALL: prepare without broadcasting ──
  const handleSweepAll = async () => {
    if (!destAddr || isBanned) return;
    const unlocked = parseFloat(balance.unlocked);
    if (unlocked <= 0) {
      setPrepareError('No unlocked funds to sweep.');
      return;
    }

    if (!confirm(`SWEEP_ALL: This will extinguish ALL funds (~${unlocked.toFixed(6)} XMR) from Account #${selectedAccountIndex}. Proceed to review?`)) {
      return;
    }

    setPrepareError('');
    setPhase('preparing');
    try {
      const result = await WalletService.prepareSweepAll(destAddr, selectedAccountIndex, priority);
      setPreparedTx({ ...result, isSweep: true });
      setPhase('confirm');
    } catch (e: any) {
      setPrepareError(e.message || 'Failed to prepare sweep');
      setPhase('input');
    }
  };

  // ── BROADCAST: relay the prepared tx after password ──
  const handleBroadcast = () => {
    if (!preparedTx) return;

    onRequirePassword(async () => {
      try {
        const txHash = await WalletService.relayTx(preparedTx.txMetadata);
        setDirectTxHash(txHash || preparedTx.txHash);
        setPhase('success');
      } catch (e: any) {
        // If relay fails (e.g. tx expired), go back to input
        setPrepareError(e.message?.includes('double spend')
          ? 'Transaction expired — inputs were spent. Please try again.'
          : e.message || 'Failed to broadcast transaction');
        setPreparedTx(null);
        setPhase('input');
      }
    });
  };

  // ── PHASE: SUCCESS ──
  if (phase === 'success') {
    return (
      <div className="py-12 flex flex-col items-center gap-4 text-center">
        <CheckCircle2 size={48} className="text-xmr-green" />
        <div className="text-sm uppercase text-xmr-green font-black">Transaction Dispatched</div>

        {directTxHash && (
          <div className="space-y-3 flex flex-col items-center">
            <div className="bg-black/20 p-3 border border-xmr-border/30 flex items-center gap-3">
              <div className="text-[11px] font-mono text-xmr-green break-all max-w-[280px]">
                {directTxHash}
              </div>
              <button
                onClick={() => navigator.clipboard.writeText(directTxHash)}
                className="text-xmr-dim hover:text-xmr-green transition-colors cursor-pointer"
                title="Copy TXID"
              >
                <Copy size={16} />
              </button>
            </div>
          </div>
        )}

        {sendMode === 'multi' && (
          <div className="text-[11px] text-xmr-dim">
            {parsed.destinations.length} recipients • {multiTotal.toFixed(4)} XMR total
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-4 px-8 py-2.5 bg-xmr-green text-xmr-base text-xs font-black uppercase tracking-widest cursor-pointer hover:bg-xmr-green/80 transition-all rounded-lg"
        >
          Close
        </button>
      </div>
    );
  }

  // ── PHASE: PREPARING ──
  if (phase === 'preparing') {
    return (
      <div className="py-16 flex flex-col items-center gap-4 text-xmr-accent/60">
        <Loader2 size={36} className="animate-spin" />
        <span className="text-[11px] uppercase font-mono tracking-widest animate-pulse">
          Preparing transaction...
        </span>
        <span className="text-[10px] text-xmr-dim uppercase tracking-wider">
          Constructing ring signatures & calculating fees
        </span>
      </div>
    );
  }

  // ── PHASE: CONFIRM ──
  if (phase === 'confirm' && preparedTx) {
    const dest = preparedTx.destinations[0];
    const priorityLabels: Record<number, string> = { 0: 'Auto', 1: 'Slow', 2: 'Medium', 3: 'Fast', 4: 'Urgent' };

    return (
      <div className="space-y-5 animate-in fade-in duration-300">
        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => { setPhase('input'); setPreparedTx(null); }}
            className="w-8 h-8 flex items-center justify-center rounded-lg border border-xmr-border/30 text-xmr-dim hover:text-xmr-accent hover:border-xmr-accent/50 transition-all cursor-pointer"
          >
            <ArrowLeft size={14} />
          </button>
          <div>
            <div className="text-[11px] text-xmr-accent uppercase tracking-widest font-black">Review Transaction</div>
            <div className="text-[10px] text-xmr-dim uppercase tracking-wider">Verify details before authorizing</div>
          </div>
        </div>

        {/* Destination */}
        <div className="bg-xmr-base border border-xmr-border/40 p-4 space-y-1">
          <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Destination</div>
          {preparedTx.destinations.length === 1 ? (
            <div className="text-[11px] text-xmr-green font-mono break-all leading-relaxed">
              {dest.address}
            </div>
          ) : (
            <div className="space-y-1">
              {preparedTx.destinations.map((d, i) => (
                <div key={i} className="flex justify-between text-[11px]">
                  <span className="text-xmr-green font-mono truncate max-w-[300px]">{d.address}</span>
                  <span className="text-xmr-accent font-black shrink-0 ml-2">{d.amount} XMR</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Amount + Fee breakdown */}
        <div className="bg-xmr-base border border-xmr-border/40 p-4 space-y-3">
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Amount</span>
            <div className="text-right">
              <span className="text-lg font-black text-xmr-accent">{preparedTx.amount} XMR</span>
              {amountFiat && <div className="text-[10px] text-xmr-dim font-bold">{amountFiat} USD</div>}
            </div>
          </div>
          <div className="border-t border-xmr-border/20" />
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Network Fee</span>
            <div className="text-right">
              <span className="text-sm font-black text-xmr-dim">{preparedTx.fee} XMR</span>
              {feeFiat && <div className="text-[10px] text-xmr-dim/60 font-bold">{feeFiat} USD</div>}
            </div>
          </div>
          <div className="border-t border-xmr-border/20" />
          <div className="flex justify-between items-baseline">
            <span className="text-[10px] text-xmr-accent uppercase font-black tracking-widest">Total Deducted</span>
            <div className="text-right">
              <span className="text-lg font-black text-xmr-green">{totalXmr} XMR</span>
              {totalFiat && <div className="text-[10px] text-xmr-dim font-bold">{totalFiat} USD</div>}
            </div>
          </div>
        </div>

        {/* Priority + Sweep badge */}
        <div className="flex items-center gap-3 text-[10px] text-xmr-dim uppercase font-black tracking-widest">
          <span>Priority: <span className="text-xmr-green">{priorityLabels[priority] || 'Auto'}</span></span>
          {preparedTx.isSweep && <span className="px-2 py-0.5 bg-xmr-accent/10 border border-xmr-accent/30 text-xmr-accent rounded">Sweep All</span>}
        </div>

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={() => { setPhase('input'); setPreparedTx(null); }}
            className="flex-1 py-3.5 border border-xmr-border text-xmr-dim font-black uppercase tracking-widest text-[11px] cursor-pointer hover:border-xmr-accent transition-colors rounded-lg"
          >
            Go Back
          </button>
          <button
            onClick={handleBroadcast}
            disabled={isSending}
            className="flex-[2] py-3.5 bg-xmr-green text-xmr-base font-black uppercase tracking-widest text-[11px] cursor-pointer hover:bg-xmr-green/80 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg"
          >
            {isSending ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
            {isSending ? 'Broadcasting...' : 'Authorize & Send'}
          </button>
        </div>
      </div>
    );
  }

  // ── PHASE: INPUT (main form) ──
  return (
    <div className="space-y-4">
      {/* Prepare error */}
      {prepareError && (
        <div className="flex items-center gap-2 p-3 bg-red-500/10 border border-red-500/30 text-red-500 text-[11px] font-black uppercase animate-in fade-in">
          <AlertTriangle size={14} /> {prepareError}
        </div>
      )}

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
            <div className="flex justify-between items-center">
              <label className="text-[11px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                <DollarSign size={10} /> Amount (XMR)
              </label>
              <div className="text-[10px] font-black text-xmr-green/60 uppercase tracking-widest">
                Unlocked: {balance.unlocked} XMR
              </div>
            </div>
            <div className="relative group">
              <input
                type="number"
                min="0"
                value={sendAmount}
                onChange={(e) => {
                  const val = e.target.value;
                  if (parseFloat(val) < 0) return;
                  setSendAmount(val);
                }}
                placeholder="0.00"
                className="w-full bg-xmr-base border border-xmr-border p-3 text-2xl font-black text-xmr-accent focus:border-xmr-accent outline-none pr-24"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                <button
                  onClick={handleSweepAll}
                  className="px-2 py-1 bg-xmr-green/10 text-xmr-green text-[9px] font-black uppercase border border-xmr-green/30 hover:bg-xmr-green hover:text-xmr-base transition-all cursor-pointer"
                >
                  Sweep_All
                </button>
              </div>
            </div>

            {/* Percentage Quick Select */}
            <div className="grid grid-cols-4 gap-1 mt-2">
              {[25, 50, 75, 100].map(pct => (
                <button
                  key={pct}
                  onClick={() => {
                    const unlocked = parseFloat(balance.unlocked);
                    if (unlocked > 0) {
                      if (pct === 100) {
                        setSendAmount(Math.max(0, unlocked - 0.0001).toFixed(6));
                      } else {
                        setSendAmount((unlocked * (pct / 100)).toFixed(6));
                      }
                    }
                  }}
                  className="py-1.5 bg-xmr-surface/50 border border-xmr-border/30 text-[9px] text-xmr-dim font-black uppercase hover:border-xmr-accent hover:text-xmr-accent transition-all cursor-pointer"
                >
                  {pct}%
                </button>
              ))}
            </div>
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

      {/* ── Fee Priority Selection ── */}
      <div className="space-y-2">
        <label className="text-[11px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5 px-1">
          <Coins size={10} /> Network_Fee_Priority
        </label>
        <div className="grid grid-cols-5 gap-1 bg-xmr-surface/30 p-1 border border-xmr-border/30 rounded-sm">
          {[
            { label: 'Slow', val: 1 },
            { label: 'Auto', val: 0 },
            { label: 'Med', val: 2 },
            { label: 'Fast', val: 3 },
            { label: 'Urgent', val: 4 }
          ].map((lvl) => {
            const xmrFee = feeEstimates[lvl.val];
            const streetPriceStr = stats?.price?.street || '0';
            const streetPrice = parseFloat(streetPriceStr.replace(/[$,]/g, ''));
            const usdFee = xmrFee && streetPrice ? (parseFloat(xmrFee) * streetPrice * 3000).toFixed(4) : null;

            return (
              <button
                key={lvl.val}
                onClick={() => setPriority(lvl.val)}
                className={`h-[42px] px-1 flex flex-col items-center justify-center transition-all cursor-pointer rounded-sm ${priority === lvl.val
                  ? 'bg-xmr-accent text-xmr-base'
                  : 'text-xmr-dim hover:text-xmr-green hover:bg-xmr-green/5'
                  }`}
              >
                <span className="text-[10px] font-black uppercase">{lvl.label}</span>
                {usdFee && (
                  <span className={`text-[10px] font-mono mt-0.5 font-bold ${priority === lvl.val ? 'text-xmr-base' : 'text-xmr-green/80'}`}>
                    ${usdFee}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

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
            window.api.openExternal('https://xmr.bio');
          }}
          className="text-[10px] text-xmr-dim hover:text-xmr-green underline transition-colors font-black tracking-widest"
        >
          CLAIM_XMR_BIO_PAGE
        </a>
      </div>

      <button
        disabled={
          isSending ||
          status === 'SYNCING' ||
          (sendMode === 'single'
            ? isBanned || !destAddr || !sendAmount
            : parsed.destinations.length === 0 || parsed.errors.length > 0)
        }
        onClick={handlePrepare}
        className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-2 cursor-pointer rounded-lg ${
          isBanned && sendMode === 'single'
            ? 'bg-red-950 text-red-500 cursor-not-allowed'
            : 'bg-xmr-accent text-xmr-base hover:bg-xmr-green hover:text-xmr-base disabled:opacity-50 disabled:cursor-not-allowed'
        }`}
      >
        <Send size={18} />
        {status === 'SYNCING'
          ? `Syncing${syncPercent > 0 ? ` (${syncPercent.toFixed(0)}%)` : ''}...`
          : isBanned && sendMode === 'single'
          ? 'Mission_Aborted'
          : sendMode === 'multi'
          ? `Prepare ${parsed.destinations.length} Transfers`
          : 'Prepare_Dispatch'}
      </button>
    </div>
  );
}
