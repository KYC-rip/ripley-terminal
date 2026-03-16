/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Ghost, ArrowDown, Shield, RefreshCw, Copy, Check, X, ArrowRight, AlertCircle, Zap, ChevronRight, Radio, ArrowUpDown, Clock, Server, Loader2, CheckCircle2 } from 'lucide-react';
import { Card } from './Card';
import { CurrencySelector } from './CurrencySelector';
import { AddressDisplay } from './common/AddressDisplay';
import { useCurrencies, type Currency } from '../hooks/useCurrencies';
import {
  fetchBridgeEstimateV2, createBridgeTradeV2, fetchBridgeStatusV2,
  type BridgeEstimateV2, type BridgeRoute, type BridgeTradeV2
} from '../services/swap';
import { useVault } from '../hooks/useVault';
import { getOrCreateSubaddress } from '../services/subaddressService';

interface GhostViewProps {
  localXmrAddress: string;
}

type GhostStep = 'config' | 'processing' | 'completed';

interface LogLine {
  id: number;
  time: string;
  text: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

export function GhostView({ localXmrAddress }: GhostViewProps) {
  const { currencies } = useCurrencies();
  const { createSubaddress, subaddresses } = useVault();

  // Form state
  const [fromCoin, setFromCoin] = useState<Currency>(CurrencySelector.Bitcoin);
  const [toCoin, setToCoin] = useState<Currency>(CurrencySelector.Monero);
  const [amount, setAmount] = useState('');
  const [destAddress, setDestAddress] = useState('');
  const [refundAddress, setRefundAddress] = useState('');

  // Estimate state
  const [routeInfo, setRouteInfo] = useState<BridgeEstimateV2 | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<BridgeRoute | null>(null);
  const [isEstimating, setIsEstimating] = useState(false);
  const [amountError, setAmountError] = useState('');

  // Trade state
  const [step, setStep] = useState<GhostStep>('config');
  const [isCreating, setIsCreating] = useState(false);
  const [trades, setTrades] = useState<BridgeTradeV2[]>([]);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);

  // Route drawer state
  const [routeDrawerOpen, setRouteDrawerOpen] = useState(false);
  const [sortBy, setSortBy] = useState<'suggested' | 'rate' | 'speed'>('suggested');

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Sorted routes
  const sortedRoutes = useMemo(() => {
    if (!routeInfo?.routes) return [];
    const routes = [...routeInfo.routes];
    if (sortBy === 'rate') {
      routes.sort((a, b) => (b.amount_to ?? 0) - (a.amount_to ?? 0));
    } else if (sortBy === 'speed') {
      routes.sort((a, b) => {
        const etaDiff = (a.eta ?? 999) - (b.eta ?? 999);
        if (etaDiff !== 0) return etaDiff;
        return (b.amount_to ?? 0) - (a.amount_to ?? 0);
      });
    }
    return routes;
  }, [routeInfo?.routes, sortBy]);

  // Init default coins from fetched currencies
  useEffect(() => {
    if (currencies.length > 0) {
      const btc = currencies.find(c => c.ticker.toLowerCase() === 'btc' && c.network === 'Mainnet');
      const xmr = currencies.find(c => c.ticker.toLowerCase() === 'xmr');
      if (btc) setFromCoin(btc);
      if (xmr) setToCoin(xmr);
    }
  }, [currencies]);

  // Auto-fill XMR address with subaddress reuse
  const generatingSubRef = useRef(false);
  useEffect(() => {
    if (toCoin?.ticker.toLowerCase() !== 'xmr' || !localXmrAddress) return;
    if (generatingSubRef.current) return;

    (async () => {
      generatingSubRef.current = true;
      try {
        const addr = await getOrCreateSubaddress('Ghost', subaddresses, createSubaddress);
        setDestAddress(addr || localXmrAddress);
      } catch {
        setDestAddress(localXmrAddress);
      } finally {
        generatingSubRef.current = false;
      }
    })();
  }, [toCoin, localXmrAddress, createSubaddress, subaddresses]);

  // Debounced estimate
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setRouteInfo(null);
    setSelectedRoute(null);
    setAmountError('');

    if (!fromCoin || !toCoin || !amount || parseFloat(amount) <= 0) return;

    debounceRef.current = setTimeout(async () => {
      setIsEstimating(true);
      try {
        const est = await fetchBridgeEstimateV2(
          fromCoin.ticker, toCoin.ticker, parseFloat(amount),
          fromCoin.network, toCoin.network
        );
        setRouteInfo(est);
        if (est.routes.length > 0) setSelectedRoute(est.routes[0]);
      } catch (e: any) {
        setAmountError(e.message || 'Estimate failed');
      } finally {
        setIsEstimating(false);
      }
    }, 800);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [fromCoin, toCoin, amount]);

  // Polling
  useEffect(() => {
    if (step !== 'processing' || trades.length === 0) return;

    const poll = async () => {
      try {
        const updated = await fetchBridgeStatusV2(trades[0].id, trades[0].engine);
        setTrades(updated);

        // Update log on status changes
        const leg1 = updated[0];
        const leg2 = updated.length > 1 ? updated[1] : null;
        const l1s = leg1.status.toUpperCase();

        addLog(`Leg_1: ${l1s}`, l1s === 'FINISHED' ? 'success' : l1s === 'FAILED' ? 'error' : 'info');
        if (leg2) {
          const l2s = leg2.status.toUpperCase();
          addLog(`Leg_2: ${l2s}`, l2s === 'FINISHED' ? 'success' : l2s === 'FAILED' ? 'error' : 'info');
        }

        // Stop polling when all legs finished/failed
        const allDone = updated.every(t =>
          ['FINISHED', 'FAILED', 'REFUNDED', 'EXPIRED'].includes(t.status.toUpperCase())
        );
        if (allDone && pollRef.current) {
          clearInterval(pollRef.current);
          const allFinished = updated.every(t => t.status.toUpperCase() === 'FINISHED');
          if (allFinished) {
            addLog('Ghost protocol completed successfully', 'success');
            setStep('completed');
          }
        }
      } catch { /* silent retry on next interval */ }
    };

    poll(); // immediate first poll
    pollRef.current = setInterval(poll, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, trades.length > 0 ? trades[0].id : '']); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  const addLog = (text: string, type: LogLine['type'] = 'info') => {
    setLogs(prev => [...prev, {
      id: ++logIdRef.current,
      time: new Date().toLocaleTimeString('en-US', { hour12: false }),
      text,
      type,
    }]);
  };

  const handleCreate = async () => {
    if (!selectedRoute || !destAddress || isCreating) return;
    setIsCreating(true);
    setLogs([]);
    logIdRef.current = 0;

    try {
      addLog(`Initializing ghost sequence: ${fromCoin.ticker} → XMR → ${toCoin.ticker}`);
      addLog(`Route: ${selectedRoute.bridgeLabel || selectedRoute.provider}`);

      const result = await createBridgeTradeV2({
        engine: selectedRoute.engine,
        from_currency: fromCoin.ticker,
        from_network: fromCoin.network,
        to_currency: toCoin.ticker,
        to_network: toCoin.network,
        amount_from: parseFloat(amount),
        address_to: destAddress,
        refund_address: selectedRoute.requiresRefund ? refundAddress : undefined,
      });
      setTrades(result);
      setStep('processing');
      setRouteDrawerOpen(false);
      addLog(`Trade created: ${result[0].id}`, 'success');
      addLog('Awaiting deposit...');
    } catch (e: any) {
      addLog(`Trade failed: ${e.message}`, 'error');
      setAmountError(e.message || 'Trade creation failed');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(label);
    setTimeout(() => setCopyFeedback(null), 2000);
  };

  const handleReset = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setStep('config');
    setTrades([]);
    setLogs([]);
    setRouteInfo(null);
    setSelectedRoute(null);
  };

  const handleSwapCoins = () => {
    const tmp = fromCoin;
    setFromCoin(toCoin);
    setToCoin(tmp);
    setAmount('');
    setDestAddress('');
  };

  const statusColor = (status: string) => {
    const s = status.toUpperCase();
    if (s === 'FINISHED') return 'text-xmr-green';
    if (s === 'FAILED' || s === 'EXPIRED' || s === 'REFUNDED') return 'text-xmr-error';
    if (s === 'SENDING') return 'text-xmr-ghost';
    return 'text-xmr-accent';
  };

  // ─── Route Drawer ───
  const RouteDrawer = () => (
    <>
      {routeDrawerOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={() => setRouteDrawerOpen(false)} />
      )}
      <div className={`fixed top-0 right-0 h-full w-80 bg-xmr-surface border-l border-xmr-border/40 z-50 flex flex-col transition-transform duration-300 ease-in-out shadow-2xl ${routeDrawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-xmr-border/20 bg-xmr-base/50">
          <div className="flex items-center gap-2">
            <Ghost size={12} className="text-xmr-ghost" />
            <span className="text-[10px] font-black text-xmr-ghost uppercase tracking-widest">Ghost Routes</span>
            {sortedRoutes.length > 0 && (
              <span className="text-[9px] text-xmr-dim font-bold">{sortedRoutes.length}</span>
            )}
          </div>
          <button onClick={() => setRouteDrawerOpen(false)} className="text-xmr-dim hover:text-xmr-green transition-colors cursor-pointer p-1">
            <X size={16} />
          </button>
        </div>

        {/* Sort tabs */}
        <div className="flex items-center gap-1 px-3 py-2 border-b border-xmr-border/10 bg-xmr-base/30">
          <ArrowUpDown size={10} className="text-xmr-dim shrink-0" />
          {(['suggested', 'rate', 'speed'] as const).map(mode => (
            <button
              key={mode}
              onClick={() => setSortBy(mode)}
              className={`px-2 py-1 text-[9px] font-black uppercase tracking-wider rounded-sm transition-all cursor-pointer ${
                sortBy === mode
                  ? 'bg-xmr-ghost/15 text-xmr-ghost border border-xmr-ghost/30'
                  : 'text-xmr-dim hover:text-xmr-green border border-transparent'
              }`}
            >
              {mode === 'suggested' ? 'Suggested' : mode === 'rate' ? 'Best Rate' : 'Fastest'}
            </button>
          ))}
        </div>

        {/* Route list */}
        <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-2">
          {isEstimating && (
            <div className="flex items-center gap-3 text-xmr-dim p-6 justify-center">
              <RefreshCw size={14} className="animate-spin" />
              <span className="text-[10px] font-black uppercase tracking-widest">Scanning...</span>
            </div>
          )}

          {!isEstimating && sortedRoutes.map((route, i) => {
            const isSelected = selectedRoute?.engine === route.engine && selectedRoute?.provider === route.provider;
            const isPrivacy = route.kyc === 'A' && (route.log_policy === 'A' || route.log_policy === 'B');
            const etaDisplay = route.eta;

            return (
              <button
                key={`${route.engine}-${route.provider}-${i}`}
                className={`w-full text-left cursor-pointer transition-all border rounded-md p-3 relative ${isSelected
                  ? 'border-xmr-ghost bg-xmr-ghost/5 shadow-[0_0_12px_rgba(168,85,247,0.1)]'
                  : 'border-xmr-border/20 bg-xmr-surface hover:border-xmr-ghost/30'
                }`}
                onClick={() => { setSelectedRoute(route); setRouteDrawerOpen(false); }}
              >
                {isSelected && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-xmr-ghost rounded-l" />}

                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {route.providerLogo && (
                      <img src={route.providerLogo} className="w-4 h-4 rounded-full object-contain bg-white/10" alt="" onError={(e: any) => e.currentTarget.style.display = 'none'} />
                    )}
                    <span className="text-[10px] font-black uppercase text-xmr-ghost">
                      {route.bridgeLabel?.replace(/_/g, ' ') || route.provider}
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isPrivacy && (
                      <span className="text-[7px] font-bold uppercase px-1 py-0.5 bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded-sm">NO-KYC</span>
                    )}
                    {route.bridgeBadge && (
                      <span className="text-[7px] font-bold uppercase px-1 py-0.5 bg-xmr-ghost/10 text-xmr-ghost border border-xmr-ghost/20 rounded-sm">{route.bridgeBadge}</span>
                    )}
                    {i === 0 && (
                      <span className="text-[7px] font-black uppercase px-1 py-0.5 bg-xmr-green/10 text-xmr-green border border-xmr-green/20 rounded-sm">
                        {sortBy === 'rate' ? 'TOP' : sortBy === 'speed' ? 'FAST' : 'BEST'}
                      </span>
                    )}
                  </div>
                </div>

                {/* Amount */}
                <div className="flex justify-between text-[10px] uppercase">
                  <span className="text-xmr-dim">Output</span>
                  <span className="text-xmr-green font-black">{route.amount_to?.toFixed(6)}</span>
                </div>

                {/* Hops */}
                {route.hops && route.hops.length > 0 && (
                  <div className="flex items-center gap-1 mt-1.5 text-[8px] text-xmr-dim">
                    {route.hops.map((hop, hi) => (
                      <React.Fragment key={hi}>
                        {hi > 0 && <ChevronRight size={7} className="text-xmr-border" />}
                        <span className="px-1 py-0.5 bg-xmr-base border border-xmr-border/20 uppercase">{hop.name}</span>
                      </React.Fragment>
                    ))}
                  </div>
                )}

                {/* Stats */}
                <div className="flex justify-between items-center mt-1 pt-1 border-t border-xmr-border/10 text-[9px] text-xmr-dim">
                  <div className="flex gap-3">
                    <span className="flex items-center gap-1"><Clock size={9} /> {etaDisplay}m</span>
                  </div>
                  <span>KYC: {route.ingressKyc || route.kyc}{route.egressKyc ? `/${route.egressKyc}` : ''}</span>
                </div>
              </button>
            );
          })}

          {!isEstimating && sortedRoutes.length === 0 && amount && parseFloat(amount) > 0 && !amountError && (
            <div className="text-center py-8">
              <Shield size={24} className="text-xmr-dim mx-auto opacity-50 mb-3" />
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest">No routes available</p>
            </div>
          )}

          {!amount && (
            <div className="p-4 space-y-3 text-[10px] text-xmr-dim uppercase">
              <div className="flex items-start gap-2"><Shield size={12} className="text-xmr-ghost shrink-0 mt-0.5" /><span>Routes through XMR anonymity set</span></div>
              <div className="flex items-start gap-2"><Zap size={12} className="text-xmr-ghost shrink-0 mt-0.5" /><span>Zero-log providers only</span></div>
              <div className="flex items-start gap-2"><Ghost size={12} className="text-xmr-ghost shrink-0 mt-0.5" /><span>Enter an amount to scan routes</span></div>
            </div>
          )}
        </div>
      </div>
    </>
  );

  // ─── COMPLETED VIEW ───
  if (step === 'completed') {
    const leg1 = trades[0];
    const leg2 = trades.length > 1 ? trades[1] : null;
    const txHash = leg2?.txOut || leg2?.details?.hashout || leg1.txOut || leg1.details?.hashout;

    return (
      <div className="max-w-xl mx-auto py-10 space-y-6 animate-in fade-in zoom-in-95 duration-300">
        <div className="flex flex-col items-center space-y-6">
          <div className="p-4 bg-xmr-ghost/10 rounded-full">
            <CheckCircle2 size={48} className="text-xmr-ghost" />
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-xl font-black uppercase tracking-widest text-xmr-ghost font-mono">GHOST_COMPLETE</h3>
            <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Privacy bridge executed successfully</p>
          </div>

          <Card className="p-6 w-full border-xmr-ghost/20 bg-xmr-surface space-y-3" topGradientAccentColor="xmr-ghost">
            <div className="flex justify-between text-[10px] font-mono uppercase">
              <span className="text-xmr-dim">Trade_ID</span>
              <span className="text-xmr-ghost font-bold">{leg1.id.slice(0, 20)}...</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono uppercase">
              <span className="text-xmr-dim">Sent</span>
              <span className="text-xmr-green">{leg1.fromAmount || leg1.depositAmount} {leg1.fromTicker}</span>
            </div>
            <div className="flex justify-between text-[10px] font-mono uppercase">
              <span className="text-xmr-dim">Received</span>
              <span className="text-xmr-green">{(leg2 || leg1).toAmount} {(leg2 || leg1).toTicker}</span>
            </div>
            {txHash && (
              <div className="flex justify-between items-center text-[10px] font-mono uppercase pt-2 border-t border-xmr-border/20">
                <span className="text-xmr-dim">TX_Out</span>
                <div className="flex items-center gap-2">
                  <span className="text-xmr-green truncate max-w-[200px]">{txHash}</span>
                  <button onClick={() => handleCopy(txHash, 'tx')} className="text-xmr-dim hover:text-xmr-green transition-colors cursor-pointer">
                    {copyFeedback === 'tx' ? <Check size={10} /> : <Copy size={10} />}
                  </button>
                </div>
              </div>
            )}
          </Card>

          <button onClick={handleReset} className="px-8 py-3 border border-xmr-ghost/50 text-xmr-ghost text-[10px] font-black uppercase tracking-[0.2em] hover:bg-xmr-ghost/10 transition-all cursor-pointer rounded-md">
            NEW_GHOST
          </button>
        </div>
      </div>
    );
  }

  // ─── PROCESSING VIEW ───
  if (step === 'processing' && trades.length > 0) {
    const leg1 = trades[0];
    const leg2 = trades.length > 1 ? trades[1] : null;
    const l1s = leg1.status.toUpperCase();
    const l2s = leg2?.status.toUpperCase();
    const allDone = trades.every(t => ['FINISHED', 'FAILED', 'REFUNDED', 'EXPIRED'].includes(t.status.toUpperCase()));

    return (
      <div className="max-w-2xl mx-auto py-8 space-y-6 animate-in fade-in duration-300">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-xmr-ghost/20 rounded-full">
              <Ghost size={20} className="text-xmr-ghost" />
            </div>
            <div>
              <h2 className="text-lg font-black uppercase tracking-tighter text-xmr-ghost">Ghost_Active</h2>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest">Privacy bridge in progress</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Radio size={10} className="text-xmr-ghost animate-pulse" />
            <span className="text-[10px] font-mono font-bold text-xmr-ghost uppercase">
              {l2s && l2s !== 'WAITING' ? `L2:${l2s}` : `L1:${l1s}`}
            </span>
          </div>
        </div>

        {/* Progress (2 legs) */}
        <div className="flex items-center gap-1">
          {['LEG_1', 'XMR_POOL', 'LEG_2', 'COMPLETE'].map((label, i) => {
            let filled = false;
            if (i === 0) filled = true; // leg1 always started
            if (i === 1) filled = ['EXCHANGING', 'SENDING', 'FINISHED'].includes(l1s);
            if (i === 2) filled = l1s === 'FINISHED' && !!leg2;
            if (i === 3) filled = !!leg2 && l2s === 'FINISHED';
            const pulsing = !filled && (
              (i === 1 && ['CONFIRMING', 'EXCHANGING'].includes(l1s)) ||
              (i === 2 && l1s === 'SENDING') ||
              (i === 3 && !!leg2 && ['SENDING', 'EXCHANGING'].includes(l2s || ''))
            );
            return (
              <div key={label} className={`flex-1 h-1.5 rounded-full transition-all duration-500 ${
                filled ? 'bg-xmr-ghost shadow-[0_0_8px_var(--color-xmr-ghost)]' :
                pulsing ? 'bg-xmr-ghost/30 animate-pulse' : 'bg-xmr-border/20'
              }`} />
            );
          })}
        </div>
        <div className="flex justify-between text-[8px] font-mono text-xmr-dim uppercase tracking-wider -mt-4">
          {['LEG_1', 'XMR_POOL', 'LEG_2', 'COMPLETE'].map((label, i) => {
            let active = false;
            if (i === 0) active = !['FINISHED'].includes(l1s) || !leg2;
            if (i === 1) active = ['EXCHANGING', 'SENDING'].includes(l1s);
            if (i === 2) active = l1s === 'FINISHED' && !!leg2 && !['FINISHED', 'FAILED'].includes(l2s || '');
            if (i === 3) active = !!leg2 && l2s === 'FINISHED';
            return <span key={label} className={active ? 'text-xmr-ghost font-bold' : ''}>{label}</span>;
          })}
        </div>

        {/* Deposit Card (leg1 waiting) */}
        {l1s === 'WAITING' && leg1.depositAddress && (
          <Card className="p-6 border-xmr-ghost/30 bg-xmr-surface space-y-4" topGradientAccentColor="xmr-ghost">
            <div className="text-center space-y-1">
              <div className="text-[10px] text-xmr-ghost font-mono uppercase tracking-widest font-bold">Deposit_Required</div>
              <p className="text-[9px] text-xmr-dim">Send the amount below to initiate the ghost sequence</p>
            </div>
            <div className="p-4 bg-xmr-base border border-xmr-ghost/20 rounded-md space-y-3">
              <div className="flex justify-between text-[10px] font-bold uppercase font-mono">
                <span className="text-xmr-dim">Amount</span>
                <span className="text-xmr-ghost">{leg1.depositAmount} {leg1.fromTicker}</span>
              </div>
              <div className="flex items-center gap-2">
                <AddressDisplay address={leg1.depositAddress} className="text-[10px] text-xmr-green font-bold flex-grow" />
                <button onClick={() => handleCopy(leg1.depositAddress!, 'deposit')} className="text-xmr-ghost shrink-0 hover:scale-110 transition-transform cursor-pointer">
                  {copyFeedback === 'deposit' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
          </Card>
        )}

        {/* Trade Summary */}
        <div className="flex items-center gap-4 justify-between text-xs font-bold uppercase tracking-tighter p-4 bg-xmr-surface/50 border border-xmr-border/20 rounded-md">
          <div className="flex flex-col gap-1">
            <span className="text-xmr-dim text-[9px]">You_Send</span>
            <span className="text-xmr-green">{leg1.fromAmount || leg1.depositAmount} {leg1.fromTicker}</span>
          </div>
          <div className="flex items-center gap-1 text-xmr-ghost">
            <ArrowRight size={10} />
            <Ghost size={12} />
            <ArrowRight size={10} />
          </div>
          <div className="flex flex-col gap-1 text-right">
            <span className="text-xmr-dim text-[9px]">You_Receive</span>
            <span className="text-xmr-green">{(leg2 || leg1).toAmount} {(leg2 || leg1).toTicker}</span>
          </div>
        </div>

        {/* Processing spinner */}
        {!allDone && (
          <div className="flex items-center justify-center gap-3 py-4">
            <Loader2 size={20} className="text-xmr-ghost animate-spin" />
            <span className="text-[10px] font-mono text-xmr-ghost font-bold uppercase tracking-widest animate-pulse">
              {l1s === 'CONFIRMING' ? 'Confirming_Deposit...' :
                l1s === 'EXCHANGING' ? 'Routing_Through_XMR...' :
                l1s === 'SENDING' && !leg2 ? 'Dispatching_Funds...' :
                l2s === 'CONFIRMING' ? 'Leg_2_Confirming...' :
                l2s === 'EXCHANGING' ? 'Leg_2_Exchanging...' :
                l2s === 'SENDING' ? 'Dispatching_Final...' :
                'Processing...'}
            </span>
          </div>
        )}

        {/* Compact Log Console */}
        <div className="bg-xmr-base border border-xmr-border/20 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-xmr-border/20 bg-xmr-surface/30">
            <div className="flex items-center gap-2">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-xmr-ghost opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-xmr-ghost" />
              </span>
              <span className="text-[9px] font-mono text-xmr-dim uppercase tracking-widest">GHOST_LOG</span>
            </div>
            <span className="text-[9px] font-mono text-xmr-dim">{logs.length}</span>
          </div>
          <div className="max-h-[100px] overflow-y-auto p-2 space-y-0.5 font-mono text-[10px] custom-scrollbar">
            {logs.length === 0 ? (
              <div className="text-xmr-dim/30 text-center py-2 uppercase text-[9px]">Initializing...</div>
            ) : logs.map(log => (
              <div key={log.id} className={`flex gap-2 ${
                log.type === 'error' ? 'text-xmr-error' :
                log.type === 'success' ? 'text-xmr-green' :
                log.type === 'warn' ? 'text-yellow-500' : 'text-xmr-dim'
              }`}>
                <span className="text-xmr-dim/40 shrink-0">{log.time}</span>
                <span className="break-all">{log.text}</span>
              </div>
            ))}
            <div ref={logEndRef} />
          </div>
        </div>

        {/* Cancel */}
        <button
          onClick={handleReset}
          className="w-full py-3 bg-xmr-error/5 hover:bg-xmr-error/10 border border-xmr-error/20 text-xmr-error text-[10px] font-bold uppercase tracking-[0.2em] flex items-center justify-center gap-2 transition-all cursor-pointer rounded-md"
        >
          <X size={14} /> Abort_Session
        </button>
      </div>
    );
  }

  // ─── CONFIG VIEW ───
  return (
    <div className="max-w-xl mx-auto py-2 space-y-3 animate-in fade-in slide-in-from-top-4 duration-500">
      <RouteDrawer />

      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-black italic uppercase text-xmr-ghost tracking-wider">Ghost_Protocol</h2>
        <p className="text-[9px] text-xmr-dim uppercase tracking-[0.15em]">Privacy bridge via XMR</p>
      </div>

      <Card className="p-4 bg-xmr-surface border-xmr-ghost/20 space-y-3" topGradientAccentColor="xmr-ghost">
        {/* Source */}
        <div className="flex gap-2 items-center bg-xmr-base border border-xmr-border/30 p-2 rounded-md focus-within:border-xmr-ghost/50 transition-colors">
          <div className="w-[45%] shrink-0">
            <CurrencySelector label="" selected={fromCoin} onSelect={setFromCoin} currencies={currencies} hideBorder themeColor="xmr-ghost" />
          </div>
          <input
            type="number"
            value={amount}
            onChange={e => setAmount(e.target.value)}
            placeholder="0.00"
            className="flex-grow bg-transparent text-right text-lg font-bold focus:outline-none pr-1 text-xmr-green min-w-0"
          />
        </div>

        {/* Swap arrow */}
        <div className="flex justify-center -my-1 relative z-10">
          <button
            onClick={handleSwapCoins}
            className="bg-xmr-base border border-xmr-ghost/40 p-1 rounded-full text-xmr-ghost hover:bg-xmr-ghost/10 hover:rotate-180 transition-all duration-300 cursor-pointer"
          >
            <ArrowDown size={12} />
          </button>
        </div>

        {/* Target */}
        <div className="flex gap-2 items-center bg-xmr-base border border-xmr-border/30 p-2 rounded-md opacity-80">
          <div className="w-[45%] shrink-0">
            <CurrencySelector label="" selected={toCoin} onSelect={setToCoin} currencies={currencies} hideBorder themeColor="xmr-ghost" />
          </div>
          <div className="flex-grow text-right text-lg font-bold pr-1 text-xmr-green min-w-0">
            {isEstimating ? (
              <span className="animate-pulse text-xmr-dim">...</span>
            ) : selectedRoute ? (
              selectedRoute.amount_to.toFixed(6)
            ) : '0.0000'}
          </div>
        </div>

        {amountError && (
          <div className="flex items-center gap-2 text-xmr-error text-[10px] font-bold uppercase">
            <AlertCircle size={12} /> {amountError}
          </div>
        )}

        {/* Route selector button */}
        <button
          onClick={() => setRouteDrawerOpen(true)}
          className="w-full flex items-center justify-between px-3 py-2 bg-xmr-base border border-xmr-border/30 rounded-md hover:border-xmr-ghost/40 transition-colors cursor-pointer group"
        >
          <div className="flex items-center gap-2">
            <Radio size={11} className="text-xmr-ghost" />
            {selectedRoute ? (
              <span className="text-[10px] font-black uppercase text-xmr-ghost">
                {selectedRoute.bridgeLabel?.replace(/_/g, ' ') || selectedRoute.provider}
                <span className="text-xmr-dim font-bold ml-2">
                  {selectedRoute.amount_to?.toFixed(6)} {toCoin?.ticker}
                </span>
              </span>
            ) : (
              <span className="text-[10px] font-black uppercase text-xmr-dim">
                {isEstimating ? 'Scanning routes...' : routeInfo?.routes?.length ? `${routeInfo.routes.length} routes available` : 'Select route'}
              </span>
            )}
          </div>
          <ChevronRight size={14} className="text-xmr-dim group-hover:text-xmr-ghost transition-colors" />
        </button>

        {/* Divider */}
        <div className="border-t border-xmr-border/15" />

        {/* Destination address */}
        <div className="space-y-1">
          <div className="flex justify-between">
            <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Destination</label>
            {toCoin?.ticker.toLowerCase() === 'xmr' && localXmrAddress && (
              <span className="text-[8px] text-xmr-green font-black uppercase tracking-widest">LOCAL_VAULT</span>
            )}
          </div>
          <input
            type="text"
            value={destAddress}
            onChange={e => setDestAddress(e.target.value)}
            placeholder="Destination address..."
            className="w-full bg-xmr-base border border-xmr-border/30 p-2.5 rounded-md text-xs text-xmr-green font-bold focus:outline-none focus:border-xmr-ghost/50 transition-colors"
          />
        </div>

        {/* Refund address */}
        {selectedRoute?.requiresRefund && (
          <div className="space-y-1">
            <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Refund_Address</label>
            <input
              type="text"
              value={refundAddress}
              onChange={e => setRefundAddress(e.target.value)}
              placeholder={`${fromCoin?.ticker.toUpperCase() || ''} refund address...`}
              className="w-full bg-xmr-base border border-xmr-border/30 p-2.5 rounded-md text-xs text-xmr-green font-bold focus:outline-none focus:border-xmr-ghost/50 transition-colors"
            />
          </div>
        )}

        {/* Execute */}
        <button
          disabled={!selectedRoute || !destAddress || isCreating || (selectedRoute?.requiresRefund && !refundAddress)}
          onClick={handleCreate}
          className="w-full py-3 bg-xmr-ghost text-white font-black uppercase tracking-[0.2em] text-sm rounded-md hover:brightness-110 transition-all flex items-center justify-center gap-3 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-lg shadow-xmr-ghost/10"
        >
          <Ghost size={16} className={isCreating ? 'animate-spin' : ''} />
          {isCreating ? 'Initializing...' : 'Execute_Ghost'}
        </button>
      </Card>
    </div>
  );
}
