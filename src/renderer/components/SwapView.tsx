/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ArrowDown, ArrowRight, ArrowUpDown, Zap, Shield, RefreshCw, AlertCircle, Copy, Check, X, Radio, CheckCircle2, Loader2, ChevronRight, Clock, Server } from 'lucide-react';
import { CurrencySelector } from './CurrencySelector';
import { Card } from './Card';
import { AddressDisplay } from './common/AddressDisplay';
import { ComplianceSelector } from './ComplianceSelector';
import { useCurrencies, type Currency } from '../hooks/useCurrencies';
import {
  fetchQuote, createTrade, getTradeStatus,
  type ExchangeQuote, type ExchangeRoute, type ComplianceState,
} from '../services/swap';
import { useVault } from '../hooks/useVault';
import { getOrCreateSubaddress } from '../services/subaddressService';

interface SwapViewProps {
  localXmrAddress: string;
}

type SwapStep = 'config' | 'active' | 'completed';

interface LogLine {
  id: number;
  time: string;
  text: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

export function SwapView({ localXmrAddress }: SwapViewProps) {
  const { currencies } = useCurrencies();
  const { createSubaddress, subaddresses } = useVault();

  // Form state
  const [fromCoin, setFromCoin] = useState<Currency>(CurrencySelector.Monero);
  const [toCoin, setToCoin] = useState<Currency | null>(CurrencySelector.Bitcoin);
  const [amount, setAmount] = useState('');
  const [destAddress, setDestAddress] = useState('');
  const [memo, setMemo] = useState('');
  const [compliance, setCompliance] = useState<ComplianceState>({ kyc: 'ANY', log: 'ANY' });

  // Quote state
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<ExchangeRoute | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState('');

  // Trade state
  const [step, setStep] = useState<SwapStep>('config');
  const [isCreating, setIsCreating] = useState(false);
  const [activeTrade, setActiveTrade] = useState<any | null>(null);
  const [tradeStatus, setTradeStatus] = useState('WAITING');
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [txOut, setTxOut] = useState<string | null>(null);

  // Route drawer state
  const [routeDrawerOpen, setRouteDrawerOpen] = useState(false);
  const [sortBy, setSortBy] = useState<'suggested' | 'rate' | 'speed'>('suggested');

  // Sorted routes
  const sortedRoutes = useMemo(() => {
    if (!quote?.routes) return [];
    const routes = [...quote.routes];
    if (sortBy === 'rate') {
      routes.sort((a, b) => (b.amount_to ?? 0) - (a.amount_to ?? 0));
    } else if (sortBy === 'speed') {
      routes.sort((a, b) => {
        const etaDiff = (a.eta ?? 999) - (b.eta ?? 999);
        if (etaDiff !== 0) return etaDiff;
        return (b.amount_to ?? 0) - (a.amount_to ?? 0);
      });
    }
    // 'suggested' = default API order (aggregator algo: privacy + rate + ETA blended)
    return routes;
  }, [quote?.routes, sortBy]);

  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const pollRef = useRef<ReturnType<typeof setInterval>>();
  const logIdRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);

  // Init default coins
  useEffect(() => {
    if (currencies.length > 0 && !toCoin) {
      const usdt = currencies.find(c => c.ticker === 'USDT' && c.network?.toLowerCase().includes('tron'));
      setToCoin(usdt || currencies.find(c => c.ticker !== 'XMR') || currencies[1]);
    }
  }, [currencies, toCoin]);

  // Auto-generate or reuse a swap subaddress when receiving XMR
  const generatingSubRef = useRef(false);
  useEffect(() => {
    if (toCoin?.ticker?.toLowerCase() !== 'xmr' || !localXmrAddress) return;
    if (generatingSubRef.current) return;

    (async () => {
      generatingSubRef.current = true;
      try {
        const addr = await getOrCreateSubaddress('Swap', subaddresses, createSubaddress);
        setDestAddress(addr || localXmrAddress);
      } catch {
        setDestAddress(localXmrAddress);
      } finally {
        generatingSubRef.current = false;
      }
    })();
  }, [toCoin, localXmrAddress, createSubaddress, subaddresses]);

  // Debounced quote
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuote(null);
    setSelectedRoute(null);
    setQuoteError('');

    if (!fromCoin || !toCoin || !amount || parseFloat(amount) <= 0) return;

    debounceRef.current = setTimeout(async () => {
      setIsQuoting(true);
      try {
        const q = await fetchQuote(
          fromCoin.ticker, fromCoin.network,
          toCoin.ticker, toCoin.network,
          parseFloat(amount), false,
          compliance.kyc, compliance.log
        );
        setQuote(q);
        if (q.routes && q.routes.length > 0) {
          setSelectedRoute(q.routes[0]);
        }
      } catch (e: any) {
        setQuoteError(e.message || 'Quote failed');
      } finally {
        setIsQuoting(false);
      }
    }, 800);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [fromCoin, toCoin, amount, compliance]);

  // Status polling
  useEffect(() => {
    if (step !== 'active' || !activeTrade) return;

    const poll = async () => {
      try {
        const status = await getTradeStatus(activeTrade.trade_id || activeTrade.id);
        const s = (status.status || '').toUpperCase();

        if (s !== tradeStatus) {
          setTradeStatus(s);
          addLog(`STATUS: ${s}`, s === 'FINISHED' ? 'success' : s === 'FAILED' ? 'error' : 'info');

          if (status.tx_out) setTxOut(status.tx_out);

          if (['FINISHED', 'FAILED', 'EXPIRED', 'REFUNDED'].includes(s)) {
            if (pollRef.current) clearInterval(pollRef.current);
            if (s === 'FINISHED') setStep('completed');
          }
        }
      } catch { /* retry on next interval */ }
    };

    poll(); // immediate first poll
    pollRef.current = setInterval(poll, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [step, activeTrade]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleSwap = async () => {
    if (!quote || !selectedRoute || !destAddress || isCreating) return;
    setIsCreating(true);
    setLogs([]);
    logIdRef.current = 0;

    try {
      addLog(`Creating trade: ${fromCoin.ticker} -> ${toCoin!.ticker}`);
      addLog(`Provider: ${selectedRoute.provider}, Amount: ${amount} ${fromCoin.ticker}`);

      const trade = await createTrade({
        id: quote.id,
        amountFrom: parseFloat(amount),
        amountTo: selectedRoute.amount_to,
        fromTicker: fromCoin.ticker,
        fromNetwork: fromCoin.network,
        toTicker: toCoin!.ticker,
        toNetwork: toCoin!.network,
        destinationAddress: destAddress,
        provider: selectedRoute.provider,
        memo: memo || undefined,
        source: 'swap',
      });

      setActiveTrade(trade);
      setTradeStatus('WAITING');
      setTxOut(null);
      setStep('active');
      setRouteDrawerOpen(false);
      addLog(`Trade created: ${trade.trade_id || trade.id}`, 'success');
      addLog('Deposit address generated. Awaiting deposit...');
    } catch (e: any) {
      addLog(`Trade failed: ${e.message}`, 'error');
      setQuoteError(e.message || 'Trade creation failed');
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
    setActiveTrade(null);
    setTradeStatus('WAITING');
    setTxOut(null);
    setLogs([]);
    setQuote(null);
    setSelectedRoute(null);
  };

  const handleSwapCoins = () => {
    if (!toCoin) return;
    const tmp = fromCoin;
    setFromCoin(toCoin);
    setToCoin(tmp);
    setAmount('');
    setDestAddress('');
  };

  const needsMemo = ['xrp', 'xlm', 'eos', 'atom'].includes(toCoin?.ticker?.toLowerCase() || '');
  const isFloating = selectedRoute ? !selectedRoute.fixed : true;

  const progressSteps = ['WAITING', 'CONFIRMING', 'EXCHANGING', 'SENDING', 'FINISHED'];
  const currentStepIndex = progressSteps.indexOf(tradeStatus);

  // ─── Route Drawer Component ───
  const RouteDrawer = () => (
    <>
      {/* Backdrop */}
      {routeDrawerOpen && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40" onClick={() => setRouteDrawerOpen(false)} />
      )}
      {/* Drawer */}
      <div className={`fixed top-0 right-0 h-full w-80 bg-xmr-surface border-l border-xmr-border/40 z-50 flex flex-col transition-transform duration-300 ease-in-out shadow-2xl ${routeDrawerOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        {/* Drawer header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-xmr-border/20 bg-xmr-base/50">
          <div className="flex items-center gap-2">
            <Radio size={12} className="text-xmr-accent" />
            <span className="text-[10px] font-black text-xmr-accent uppercase tracking-widest">Routes</span>
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
                  ? 'bg-xmr-accent/15 text-xmr-accent border border-xmr-accent/30'
                  : 'text-xmr-dim hover:text-xmr-green border border-transparent'
              }`}
            >
              {mode === 'suggested' ? 'Suggested' : mode === 'rate' ? 'Best Rate' : 'Fastest'}
            </button>
          ))}
        </div>

        {/* Route list */}
        <div className="flex-grow overflow-y-auto custom-scrollbar p-3 space-y-2">
          {isQuoting && (
            <div className="flex items-center gap-3 text-xmr-dim p-6 justify-center">
              <RefreshCw size={14} className="animate-spin" />
              <span className="text-[10px] font-black uppercase tracking-widest">Scanning...</span>
            </div>
          )}

          {!isQuoting && sortedRoutes.map((route: any, i: number) => {
            const isSelected = selectedRoute?.provider === route.provider && selectedRoute?.fixed === route.fixed;
            const isPrivacy = route.kyc === 'A' && (route.log_policy === 'A' || route.log_policy === 'B');
            const etaDisplay = route.recorded_eta || route.eta;

            return (
              <button
                key={`${route.provider}-${route.fixed ? 'f' : 'v'}-${i}`}
                className={`w-full text-left cursor-pointer transition-all border rounded-md p-3 relative ${isSelected
                  ? 'border-xmr-accent bg-xmr-accent/5 shadow-[0_0_12px_rgba(255,102,0,0.1)]'
                  : 'border-xmr-border/20 bg-xmr-surface hover:border-xmr-accent/30'
                  }`}
                onClick={() => { setSelectedRoute(route); setRouteDrawerOpen(false); }}
              >
                {isSelected && <div className="absolute left-0 top-0 bottom-0 w-0.5 bg-xmr-accent rounded-l" />}
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {route.providerLogo && (
                      <img src={route.providerLogo} className="w-4 h-4 rounded-full object-contain bg-white/10" alt="" onError={(e: any) => e.currentTarget.style.display = 'none'} />
                    )}
                    <span className="text-[10px] font-black uppercase text-xmr-accent">{route.provider}</span>
                  </div>
                  <div className="flex items-center gap-1">
                    {isPrivacy && (
                      <span className="text-[7px] font-bold uppercase px-1 py-0.5 bg-purple-500/10 text-purple-400 border border-purple-500/20 rounded-sm">NO-KYC</span>
                    )}
                    {!route.fixed && (
                      <span className="text-[7px] font-bold uppercase px-1 py-0.5 bg-yellow-500/10 text-yellow-500 border border-yellow-500/20 rounded-sm">FLOAT</span>
                    )}
                    {route.fixed && (
                      <span className="text-[7px] font-bold uppercase px-1 py-0.5 bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 rounded-sm">FIXED</span>
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
                  <span className="text-xmr-green font-black">
                    {!route.fixed && <span className="opacity-60 mr-0.5">~</span>}
                    {route.amount_to?.toFixed(6)}
                  </span>
                </div>

                {/* Stats row */}
                <div className="flex justify-between items-center mt-1 pt-1 border-t border-xmr-border/10 text-[9px] text-xmr-dim">
                  <div className="flex gap-3">
                    <span className="flex items-center gap-1"><Clock size={9} /> {etaDisplay}m</span>
                    {(route.spread ?? 0) > 0 && (
                      <span className="flex items-center gap-1"><Server size={9} /> {(route.spread * 100).toFixed(1)}%</span>
                    )}
                  </div>
                  <span>KYC: {route.kyc}</span>
                </div>
              </button>
            );
          })}

          {!isQuoting && sortedRoutes.length === 0 && amount && parseFloat(amount) > 0 && !quoteError && (
            <div className="text-center py-8">
              <Shield size={24} className="text-xmr-dim mx-auto opacity-50 mb-3" />
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest">No providers available</p>
            </div>
          )}

          {!amount && (
            <div className="p-4 space-y-3 text-[10px] text-xmr-dim uppercase">
              <div className="flex items-start gap-2"><Zap size={12} className="text-xmr-accent shrink-0 mt-0.5" /><span>Real-time rates from 10+ providers</span></div>
              <div className="flex items-start gap-2"><Shield size={12} className="text-xmr-accent shrink-0 mt-0.5" /><span>Filter by KYC & logging policies</span></div>
              <div className="flex items-start gap-2"><RefreshCw size={12} className="text-xmr-accent shrink-0 mt-0.5" /><span>Enter an amount to see routes</span></div>
            </div>
          )}
        </div>
      </div>
    </>
  );

  // ─── COMPLETED VIEW ───
  if (step === 'completed') {
    return (
      <div className="max-w-xl mx-auto py-10 space-y-6 animate-in fade-in zoom-in-95 duration-300">
        <div className="flex flex-col items-center space-y-6">
          <div className="p-4 bg-xmr-green/10 rounded-full">
            <CheckCircle2 size={48} className="text-xmr-green" />
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-xl font-black uppercase tracking-widest text-xmr-green font-mono">SWAP_COMPLETE</h3>
            <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Transaction executed successfully</p>
          </div>

          {activeTrade && (
            <Card className="p-6 w-full border-xmr-green/20 bg-xmr-surface space-y-3">
              <div className="flex justify-between text-[10px] font-mono uppercase">
                <span className="text-xmr-dim">Trade_ID</span>
                <span className="text-xmr-green font-bold">{(activeTrade.trade_id || activeTrade.id || '').slice(0, 20)}...</span>
              </div>
              <div className="flex justify-between text-[10px] font-mono uppercase">
                <span className="text-xmr-dim">Sent</span>
                <span className="text-xmr-green">{activeTrade.amount_from} {(activeTrade.ticker_from || fromCoin.ticker).toUpperCase()}</span>
              </div>
              <div className="flex justify-between text-[10px] font-mono uppercase">
                <span className="text-xmr-dim">Received</span>
                <span className="text-xmr-green">{activeTrade.amount_to} {(activeTrade.ticker_to || toCoin?.ticker || '').toUpperCase()}</span>
              </div>
              {txOut && (
                <div className="flex justify-between items-center text-[10px] font-mono uppercase pt-2 border-t border-xmr-border/20">
                  <span className="text-xmr-dim">TX_Out</span>
                  <div className="flex items-center gap-2">
                    <span className="text-xmr-green truncate max-w-[200px]">{txOut}</span>
                    <button onClick={() => handleCopy(txOut, 'tx')} className="text-xmr-dim hover:text-xmr-green transition-colors cursor-pointer">
                      {copyFeedback === 'tx' ? <Check size={10} /> : <Copy size={10} />}
                    </button>
                  </div>
                </div>
              )}
            </Card>
          )}

          <button onClick={handleReset} className="px-8 py-3 border border-xmr-green/50 text-xmr-green text-[10px] font-black uppercase tracking-[0.2em] hover:bg-xmr-green/10 transition-all cursor-pointer rounded-md">
            NEW_SWAP
          </button>
        </div>
      </div>
    );
  }

  // ─── ACTIVE TRADE VIEW ───
  if (step === 'active' && activeTrade) {
    const depositAddr = activeTrade.address_provider || activeTrade.deposit_address || activeTrade.depositAddress || '';
    const depositAmt = activeTrade.deposit_amount || activeTrade.amount_from;

    return (
      <div className="max-w-2xl mx-auto py-8 space-y-6 animate-in fade-in duration-300">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-xmr-accent/20 rounded-full">
              <Zap size={20} className="text-xmr-accent" />
            </div>
            <div>
              <h2 className="text-lg font-black uppercase tracking-tighter text-xmr-accent">Swap_Active</h2>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest">Trade in progress</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Radio size={10} className="text-xmr-green animate-pulse" />
            <span className="text-[10px] font-mono font-bold text-xmr-accent uppercase">{tradeStatus}</span>
          </div>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center gap-1">
          {progressSteps.map((s, i) => (
            <div key={s} className={`flex-1 h-1.5 rounded-full transition-all duration-500 ${i <= currentStepIndex ? 'bg-xmr-green shadow-[0_0_8px_var(--color-xmr-green)]' :
                i === currentStepIndex + 1 ? 'bg-xmr-accent/30 animate-pulse' : 'bg-xmr-border/20'
              }`} />
          ))}
        </div>
        <div className="flex justify-between text-[8px] font-mono text-xmr-dim uppercase tracking-wider -mt-4">
          {progressSteps.map((s, i) => (
            <span key={s} className={i <= currentStepIndex ? 'text-xmr-green font-bold' : ''}>{s}</span>
          ))}
        </div>

        {/* Deposit Card */}
        {tradeStatus === 'WAITING' && depositAddr && (
          <Card className="p-6 border-xmr-accent/30 bg-xmr-surface space-y-4">
            <div className="text-center space-y-1">
              <div className="text-[10px] text-xmr-accent font-mono uppercase tracking-widest font-bold">Deposit_Required</div>
              {isFloating ? (
                <p className="text-[9px] text-xmr-dim">
                  Floating rate — exchange adjusts to actual deposited amount
                  {quote?.min || quote?.max ? (
                    <span className="text-xmr-accent"> (range: {quote.min || '?'}–{quote.max || '?'} {(activeTrade.ticker_from || fromCoin.ticker).toUpperCase()})</span>
                  ) : null}
                </p>
              ) : (
                <p className="text-[9px] text-xmr-dim">Send the exact amount to the address below</p>
              )}
            </div>
            <div className="p-4 bg-xmr-base border border-xmr-accent/20 rounded-md space-y-3">
              <div className="flex justify-between text-[10px] font-bold uppercase font-mono">
                <span className="text-xmr-dim">{isFloating ? 'Suggested Amount' : 'Amount'}</span>
                <span className="text-xmr-accent">{depositAmt} {(activeTrade.ticker_from || fromCoin.ticker).toUpperCase()}</span>
              </div>
              <div className="flex items-center gap-2">
                <AddressDisplay address={depositAddr} className="text-[10px] text-xmr-green font-bold flex-grow" />
                <button onClick={() => handleCopy(depositAddr, 'deposit')} className="text-xmr-accent shrink-0 hover:scale-110 transition-transform cursor-pointer">
                  {copyFeedback === 'deposit' ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            </div>
            {isFloating && (
              <div className="text-[9px] text-xmr-dim/70 font-mono text-center uppercase leading-relaxed">
                Any amount within the min/max range will be accepted and swapped at market rate
              </div>
            )}
          </Card>
        )}

        {/* Trade Summary */}
        <div className="flex items-center gap-4 justify-between text-xs font-bold uppercase tracking-tighter p-4 bg-xmr-surface/50 border border-xmr-border/20 rounded-md">
          <div className="flex flex-col gap-1">
            <span className="text-xmr-dim text-[9px]">You_Send</span>
            <span className="text-xmr-green">{activeTrade.amount_from} {(activeTrade.ticker_from || '').toUpperCase()}</span>
          </div>
          <ArrowRight size={16} className="text-xmr-dim" />
          <div className="flex flex-col gap-1 text-right">
            <span className="text-xmr-dim text-[9px]">You_Receive</span>
            <span className="text-xmr-green">{activeTrade.amount_to} {(activeTrade.ticker_to || '').toUpperCase()}</span>
          </div>
        </div>

        {/* Processing spinner */}
        {['CONFIRMING', 'EXCHANGING', 'SENDING'].includes(tradeStatus) && (
          <div className="flex items-center justify-center gap-3 py-4">
            <Loader2 size={20} className="text-xmr-accent animate-spin" />
            <span className="text-[10px] font-mono text-xmr-accent font-bold uppercase tracking-widest animate-pulse">
              {tradeStatus === 'CONFIRMING' ? 'Confirming_Deposit...' :
                tradeStatus === 'EXCHANGING' ? 'Executing_Swap...' :
                  'Dispatching_Funds...'}
            </span>
          </div>
        )}

        {/* Compact Log Console */}
        <div className="bg-xmr-base border border-xmr-border/20 rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-xmr-border/20 bg-xmr-surface/30">
            <div className="flex items-center gap-2">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-xmr-green opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-xmr-green" />
              </span>
              <span className="text-[9px] font-mono text-xmr-dim uppercase tracking-widest">SWAP_LOG</span>
            </div>
            <span className="text-[9px] font-mono text-xmr-dim">{logs.length}</span>
          </div>
          <div className="max-h-[100px] overflow-y-auto p-2 space-y-0.5 font-mono text-[10px] custom-scrollbar">
            {logs.length === 0 ? (
              <div className="text-xmr-dim/30 text-center py-2 uppercase text-[9px]">Initializing...</div>
            ) : logs.map(log => (
              <div key={log.id} className={`flex gap-2 ${log.type === 'error' ? 'text-xmr-error' :
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

        {/* Cancel button */}
        <button
          onClick={handleReset}
          className="w-full py-3 bg-xmr-error/5 hover:bg-xmr-error/10 border border-xmr-error/20 text-xmr-error text-[10px] font-bold uppercase tracking-[0.2em] flex items-center justify-center gap-2 transition-all cursor-pointer rounded-md"
        >
          <X size={14} /> Cancel_Trade
        </button>
      </div>
    );
  }

  // ─── CONFIG VIEW ───
  return (
    <div className="max-w-xl mx-auto py-2 space-y-3 animate-in fade-in slide-in-from-top-4 duration-500">
      <RouteDrawer />

      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-black italic uppercase text-xmr-accent tracking-wider">Swap_Terminal</h2>
        <p className="text-[9px] text-xmr-dim uppercase tracking-[0.15em]">Aggregated rates</p>
      </div>

      <Card className="p-4 bg-xmr-surface border-xmr-accent/20 space-y-3">
        {/* Source */}
        <div className="flex gap-2 items-center bg-xmr-base border border-xmr-border/30 p-2 rounded-md focus-within:border-xmr-accent/50 transition-colors">
          <div className="w-[45%] shrink-0">
            <CurrencySelector label="" selected={fromCoin} onSelect={setFromCoin} currencies={currencies} hideBorder />
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
            disabled={!toCoin}
            className="bg-xmr-base border border-xmr-accent/40 p-1 rounded-full text-xmr-accent hover:bg-xmr-accent/10 hover:rotate-180 transition-all duration-300 cursor-pointer disabled:opacity-30"
          >
            <ArrowDown size={12} />
          </button>
        </div>

        {/* Target */}
        <div className="flex gap-2 items-center bg-xmr-base border border-xmr-border/30 p-2 rounded-md opacity-80">
          <div className="w-[45%] shrink-0">
            <CurrencySelector label="" selected={toCoin} onSelect={setToCoin} currencies={currencies} hideBorder />
          </div>
          <div className="flex-grow text-right text-lg font-bold pr-1 text-xmr-green min-w-0">
            {isQuoting ? (
              <span className="animate-pulse text-xmr-dim">...</span>
            ) : selectedRoute ? (
              selectedRoute.amount_to.toFixed(6)
            ) : '0.0000'}
          </div>
        </div>

        {quoteError && (
          <div className="flex items-center gap-2 text-xmr-error text-[10px] font-bold uppercase">
            <AlertCircle size={12} /> {quoteError}
          </div>
        )}

        {/* Route selector button */}
        <button
          onClick={() => setRouteDrawerOpen(true)}
          className="w-full flex items-center justify-between px-3 py-2 bg-xmr-base border border-xmr-border/30 rounded-md hover:border-xmr-accent/40 transition-colors cursor-pointer group"
        >
          <div className="flex items-center gap-2">
            <Radio size={11} className="text-xmr-accent" />
            {selectedRoute ? (
              <span className="text-[10px] font-black uppercase text-xmr-accent">
                {selectedRoute.provider}
                <span className="text-xmr-dim font-bold ml-2">
                  {selectedRoute.amount_to?.toFixed(6)} {toCoin?.ticker}
                </span>
                {!selectedRoute.fixed && <span className="text-xmr-dim/60 ml-1.5 text-[8px]">FLOAT</span>}
              </span>
            ) : (
              <span className="text-[10px] font-black uppercase text-xmr-dim">
                {isQuoting ? 'Scanning routes...' : quote?.routes?.length ? `${quote.routes.length} routes available` : 'Select route'}
              </span>
            )}
          </div>
          <ChevronRight size={14} className="text-xmr-dim group-hover:text-xmr-accent transition-colors" />
        </button>

        {/* Divider */}
        <div className="border-t border-xmr-border/15" />

        {/* Address */}
        <div className="space-y-1">
          <div className="flex justify-between">
            <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Destination</label>
            {toCoin?.ticker?.toLowerCase() === 'xmr' && localXmrAddress && (
              <span className="text-[8px] text-xmr-green font-black uppercase tracking-widest">LOCAL_VAULT</span>
            )}
          </div>
          <input
            type="text"
            value={destAddress}
            onChange={e => setDestAddress(e.target.value)}
            placeholder="Destination address..."
            className="w-full bg-xmr-base border border-xmr-border/30 p-2.5 rounded-md text-xs text-xmr-green font-bold focus:outline-none focus:border-xmr-accent/50 transition-colors"
          />
        </div>

        {needsMemo && (
          <div className="space-y-1">
            <label className="text-[9px] font-black text-xmr-dim uppercase ml-1">Memo / Tag</label>
            <input
              type="text"
              value={memo}
              onChange={e => setMemo(e.target.value)}
              placeholder="Required for this coin..."
              className="w-full bg-xmr-base border border-xmr-border/30 p-2.5 rounded-md text-xs text-xmr-green font-bold focus:outline-none focus:border-xmr-accent/50 transition-colors"
            />
          </div>
        )}

        {/* Compliance */}
        <ComplianceSelector
          value={compliance}
          onChange={setCompliance}
        />

        {/* Execute */}
        <button
          disabled={!selectedRoute || !destAddress || isCreating}
          onClick={handleSwap}
          className="w-full py-3 bg-xmr-accent text-xmr-base font-black uppercase tracking-[0.2em] text-sm rounded-md hover:bg-xmr-green hover:text-xmr-base transition-all flex items-center justify-center gap-3 disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer active:scale-[0.98] shadow-lg shadow-xmr-accent/10"
        >
          <Zap size={16} className={isCreating ? 'animate-spin' : ''} />
          {isCreating ? 'Creating_Trade...' : 'Execute_Swap'}
        </button>
      </Card>
    </div>
  );
}
