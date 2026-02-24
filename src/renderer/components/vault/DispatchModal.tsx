import React, { useState, useEffect, useRef } from 'react';
import { X, Send, Ghost, ArrowRight, DollarSign, Loader2, CheckCircle2, AlertTriangle, Wallet, RefreshCw, Lock } from 'lucide-react';
import { useVault } from '../../contexts/VaultContext';
import { CurrencySelector } from '../CurrencySelector';
import { useCurrencies, Currency } from '../../hooks/useCurrencies';
import { fetchQuote, createTrade, getTradeStatus, ExchangeQuote, ExchangeResponse } from '../../services/swap';

interface DispatchModalProps {
  onClose: () => void;
  initialAddress?: string;
  sourceSubaddressIndex?: number;
}

type Tab = 'direct' | 'ghost';
type GhostPhase = 'configure' | 'quoting' | 'quoted' | 'creating' | 'sending' | 'tracking' | 'complete' | 'error';

export function DispatchModal({ onClose, initialAddress = '', sourceSubaddressIndex }: DispatchModalProps) {
  const { sendXmr, isSending, activeId } = useVault();
  const [tab, setTab] = useState<Tab>('direct');

  // --- Password Confirmation ---
  const [showPasswordGate, setShowPasswordGate] = useState(false);
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [isVerifying, setIsVerifying] = useState(false);
  const pendingActionRef = useRef<(() => Promise<void>) | null>(null);

  // --- Direct Send State ---
  const [destAddr, setDestAddr] = useState(initialAddress);
  const [sendAmount, setSendAmount] = useState('');
  const [isBanned, setIsBanned] = useState(false);
  const [directSent, setDirectSent] = useState(false);
  const [directTxHash, setDirectTxHash] = useState('');

  // --- Ghost Send State ---
  const { currencies } = useCurrencies();
  const [ghostCurrency, setGhostCurrency] = useState<Currency | null>(null);
  const [ghostReceiverAddr, setGhostReceiverAddr] = useState('');
  const [ghostXmrAmount, setGhostXmrAmount] = useState('');
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const [ghostPhase, setGhostPhase] = useState<GhostPhase>('configure');
  const [tradeResponse, setTradeResponse] = useState<ExchangeResponse | null>(null);
  const [tradeStatus, setTradeStatus] = useState('');
  const [ghostError, setGhostError] = useState('');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Ban check
  useEffect(() => {
    if (destAddr.length > 30) {
      fetch(`https://api.kyc.rip/v1/tools/ban-list?address=${destAddr}`)
        .then(res => res.json())
        .then((data: any) => setIsBanned(data.results && data.results.length > 0))
        .catch(() => setIsBanned(false));
    } else setIsBanned(false);
  }, [destAddr]);

  // Default ghost currency
  useEffect(() => {
    if (currencies.length > 0 && !ghostCurrency)
      setGhostCurrency(currencies.find(c => c.ticker === 'usdt' && c.network === 'TRC20') || currencies[0]);
  }, [currencies, ghostCurrency]);

  // Cleanup polling on unmount
  useEffect(() => () => { if (pollingRef.current) clearInterval(pollingRef.current); }, []);

  // --- Password Gate ---
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
      // Verify password by reopening the wallet (safe — it's already open)
      const res = await window.api.walletAction('open', { name: activeId, pwd: password });
      if (!res.success) throw new Error(res.error || 'Invalid password');
      // Password verified — execute the pending action
      setShowPasswordGate(false);
      if (pendingActionRef.current) await pendingActionRef.current();
    } catch (e: any) {
      setPasswordError(e.message?.includes('invalid password') ? 'WRONG_PASSWORD' : (e.message || 'Verification failed'));
    } finally {
      setIsVerifying(false);
    }
  };

  // --- Direct Send ---
  const handleDirectSend = async () => {
    if (!destAddr || !sendAmount || isBanned) return;
    requirePassword(async () => {
      const txHash = await sendXmr(destAddr, parseFloat(sendAmount));
      if (txHash) {
        setDirectTxHash(txHash);
        setDirectSent(true);
      }
    });
  };

  // --- Ghost Send: Get Quote ---
  const handleGetQuote = async () => {
    if (!ghostCurrency || !ghostXmrAmount || parseFloat(ghostXmrAmount) <= 0) return;
    setGhostPhase('quoting');
    setGhostError('');
    try {
      const q = await fetchQuote(
        'xmr', 'Mainnet',
        ghostCurrency.ticker, ghostCurrency.network || 'Mainnet',
        parseFloat(ghostXmrAmount), false
      );
      setQuote(q);
      setGhostPhase('quoted');
    } catch (e: any) {
      setGhostError(e.message || 'Quote failed');
      setGhostPhase('error');
    }
  };

  // --- Ghost Send: Execute (password-gated) ---
  const handleGhostExecute = () => {
    if (!quote || !ghostCurrency || !ghostReceiverAddr) return;
    requirePassword(async () => {
      setGhostPhase('creating');
      setGhostError('');
      try {
        const route = quote.routes?.[0];
        const trade = await createTrade({
          id: quote.id,
          amountFrom: quote.amount_from,
          amountTo: quote.amount_to,
          fromTicker: 'xmr',
          fromNetwork: 'Mainnet',
          toTicker: ghostCurrency!.ticker,
          toNetwork: ghostCurrency!.network || 'Mainnet',
          destinationAddress: ghostReceiverAddr,
          provider: route?.provider || quote.provider,
          source: 'ghost'
        });
        setTradeResponse(trade);

        setGhostPhase('sending');
        const depositAddr = trade.deposit_address || trade.address_provider;
        const depositAmt = trade.deposit_amount || trade.amount_from;
        await sendXmr(depositAddr, depositAmt);

        setGhostPhase('tracking');
        setTradeStatus('WAITING');
        const tradeId = trade.trade_id || trade.id || '';

        pollingRef.current = setInterval(async () => {
          try {
            const status = await getTradeStatus(tradeId);
            const s = (status as any)?.status?.toUpperCase() || 'WAITING';
            setTradeStatus(s);
            if (['FINISHED', 'COMPLETE', 'COMPLETED'].includes(s)) {
              setGhostPhase('complete');
              if (pollingRef.current) clearInterval(pollingRef.current);
            } else if (['FAILED', 'REFUNDED', 'EXPIRED'].includes(s)) {
              setGhostError(`Trade ${s.toLowerCase()}`);
              setGhostPhase('error');
              if (pollingRef.current) clearInterval(pollingRef.current);
            }
          } catch { /* swallow polling errors */ }
        }, 10000);
      } catch (e: any) {
        setGhostError(e.message || 'Ghost send failed');
        setGhostPhase('error');
      }
    });
  };

  const resetGhost = () => {
    setGhostPhase('configure');
    setQuote(null);
    setTradeResponse(null);
    setTradeStatus('');
    setGhostError('');
    if (pollingRef.current) clearInterval(pollingRef.current);
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-xmr-base/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
      <div className="w-full max-w-xl bg-xmr-surface border border-xmr-border relative flex flex-col max-h-[85vh] overflow-hidden">

        {/* ══ PASSWORD CONFIRMATION OVERLAY ══ */}
        {showPasswordGate && (
          <div className="absolute inset-0 z-10 bg-xmr-surface/95 backdrop-blur-sm flex flex-col items-center justify-center p-8 animate-in fade-in duration-200">
            <Lock size={36} className="text-xmr-accent mb-4" />
            <h4 className="text-sm font-black uppercase text-xmr-accent tracking-widest mb-1">Authorization Required</h4>
            <p className="text-[9px] text-xmr-dim uppercase tracking-wider mb-6">Enter vault password to authorize transaction</p>
            <input
              autoFocus
              type="password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setPasswordError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') verifyAndExecute(); if (e.key === 'Escape') setShowPasswordGate(false); }}
              placeholder="••••••••••••"
              className={`w-full max-w-xs bg-xmr-base border p-3 text-xl font-black text-xmr-green text-center focus:border-xmr-accent outline-none transition-all ${passwordError ? 'border-red-600' : 'border-xmr-border'}`}
            />
            {passwordError && (
              <div className="text-[9px] text-red-500 uppercase mt-2 animate-pulse">{passwordError}</div>
            )}
            <div className="flex gap-3 mt-6 w-full max-w-xs">
              <button
                onClick={() => setShowPasswordGate(false)}
                className="flex-1 py-2.5 border border-xmr-border text-xmr-dim font-black uppercase tracking-widest text-[9px] cursor-pointer hover:border-xmr-accent transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={verifyAndExecute}
                disabled={!password || isVerifying}
                className="flex-1 py-2.5 bg-xmr-accent text-xmr-base font-black uppercase tracking-widest text-[9px] cursor-pointer hover:bg-xmr-green transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isVerifying ? <Loader2 size={12} className="animate-spin" /> : <Lock size={12} />}
                {isVerifying ? 'Verifying...' : 'Authorize'}
              </button>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-xmr-border/40">
          <div>
            <h3 className="text-lg font-black italic uppercase text-xmr-accent tracking-tight">Dispatch_Sequence</h3>
            <p className="text-[9px] text-xmr-dim uppercase tracking-widest mt-0.5">
              {sourceSubaddressIndex !== undefined ? `Source: Subaddress #${sourceSubaddressIndex}` : 'Outbound transfer'}
            </p>
          </div>
          <button onClick={onClose} className="text-xmr-dim hover:text-xmr-accent transition-colors cursor-pointer p-1"><X size={20} /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-xmr-border/30">
          {([
            { id: 'direct' as const, label: 'Direct XMR', icon: <Send size={12} /> },
            { id: 'ghost' as const, label: 'Ghost Send', icon: <Ghost size={12} /> },
          ]).map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2.5 text-[9px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
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

          {/* ════════ DIRECT SEND ════════ */}
          {tab === 'direct' && (
            directSent ? (
              <div className="py-12 flex flex-col items-center gap-4 text-center">
                <CheckCircle2 size={48} className="text-xmr-green" />
                <div className="text-sm uppercase text-xmr-green font-black">Transaction Dispatched</div>
                <div className="text-[9px] font-mono text-xmr-dim break-all max-w-sm">{directTxHash}</div>
                <button onClick={onClose} className="mt-4 px-6 py-2 bg-xmr-green text-xmr-base text-[10px] uppercase tracking-widest cursor-pointer">Close</button>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[9px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                      <Wallet size={10} /> Destination
                    </label>
                    {isBanned && <span className="text-[8px] text-red-500 animate-pulse uppercase">Intercepted</span>}
                  </div>
                  <input
                    type="text" value={destAddr}
                    onChange={(e) => setDestAddr(e.target.value)}
                    placeholder="4... / 8..."
                    className={`w-full bg-xmr-base border p-3 text-[10px] text-xmr-green focus:border-xmr-accent outline-none transition-colors ${isBanned ? 'border-red-600' : 'border-xmr-border'}`}
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[9px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                    <DollarSign size={10} /> Amount (XMR)
                  </label>
                  <input
                    type="number" value={sendAmount}
                    onChange={(e) => setSendAmount(e.target.value)}
                    placeholder="0.00"
                    className="w-full bg-xmr-base border border-xmr-border p-3 text-2xl font-black text-xmr-accent focus:border-xmr-accent outline-none"
                  />
                </div>

                <button
                  disabled={isSending || isBanned || !destAddr || !sendAmount}
                  onClick={handleDirectSend}
                  className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-4 cursor-pointer ${
                    isBanned ? 'bg-red-950 text-red-500 cursor-not-allowed'
                    : 'bg-xmr-accent text-xmr-base hover:bg-xmr-green hover:text-xmr-base disabled:opacity-50 disabled:cursor-not-allowed'
                  }`}
                >
                  <Send size={18} />
                  {isSending ? 'Dispatching...' : isBanned ? 'Mission_Aborted' : 'Confirm_Dispatch'}
                </button>
              </div>
            )
          )}

          {/* ════════ GHOST SEND ════════ */}
          {tab === 'ghost' && (
            <>
              {ghostPhase === 'configure' && (
                <div className="space-y-4">
                  <div className="bg-xmr-green/5 border border-xmr-green/20 p-3 text-[9px] text-xmr-green/80 uppercase tracking-wider">
                    You send XMR • Receiver gets their chosen asset • No identity link
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                      <Ghost size={10} /> Receiver's Asset
                    </label>
                    {ghostCurrency && (
                      <CurrencySelector selected={ghostCurrency} onSelect={setGhostCurrency} label="" currencies={currencies} />
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                      <Wallet size={10} /> Receiver's Address
                    </label>
                    <input
                      type="text" value={ghostReceiverAddr}
                      onChange={(e) => setGhostReceiverAddr(e.target.value)}
                      placeholder={`${ghostCurrency?.ticker.toUpperCase() || 'Asset'} address`}
                      className="w-full bg-xmr-base border border-xmr-border p-3 text-[10px] text-xmr-green focus:border-xmr-accent outline-none"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[9px] text-xmr-dim uppercase tracking-widest flex items-center gap-1.5">
                      <DollarSign size={10} /> XMR to Spend
                    </label>
                    <input
                      type="number" value={ghostXmrAmount}
                      onChange={(e) => setGhostXmrAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full bg-xmr-base border border-xmr-border p-3 text-2xl font-black text-xmr-accent focus:border-xmr-accent outline-none"
                    />
                  </div>

                  <button
                    disabled={!ghostReceiverAddr || !ghostXmrAmount || parseFloat(ghostXmrAmount) <= 0}
                    onClick={handleGetQuote}
                    className="w-full py-3 bg-xmr-accent/20 border border-xmr-accent/40 text-xmr-accent font-black uppercase tracking-widest text-[10px] transition-all hover:bg-xmr-accent/30 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer flex items-center justify-center gap-2"
                  >
                    <ArrowRight size={14} /> Get Quote
                  </button>
                </div>
              )}

              {ghostPhase === 'quoting' && (
                <div className="py-16 flex flex-col items-center gap-3 text-xmr-accent/60 animate-pulse">
                  <Loader2 size={32} className="animate-spin" />
                  <span className="text-[9px] uppercase font-mono tracking-widest">Fetching best rate...</span>
                </div>
              )}

              {ghostPhase === 'quoted' && quote && (
                <div className="space-y-5">
                  <div className="bg-xmr-base border border-xmr-border p-4 space-y-3">
                    <div className="text-[9px] text-xmr-dim uppercase tracking-widest">Quote Summary</div>
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-lg font-black text-xmr-accent">{quote.amount_from} XMR</div>
                        <div className="text-[8px] text-xmr-dim uppercase">You send</div>
                      </div>
                      <ArrowRight size={20} className="text-xmr-dim" />
                      <div className="text-right">
                        <div className="text-lg font-black text-xmr-green">{quote.amount_to.toFixed(6)} {ghostCurrency?.ticker.toUpperCase()}</div>
                        <div className="text-[8px] text-xmr-dim uppercase">Receiver gets</div>
                      </div>
                    </div>
                    <div className="flex justify-between text-[8px] text-xmr-dim uppercase pt-2 border-t border-xmr-border/20">
                      <span>Provider: {quote.routes?.[0]?.provider || quote.provider}</span>
                      <span>ETA: ~{quote.eta || quote.routes?.[0]?.eta || '?'} min</span>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={resetGhost}
                      className="flex-1 py-3 border border-xmr-border text-xmr-dim font-black uppercase tracking-widest text-[9px] cursor-pointer hover:border-xmr-accent transition-colors"
                    >
                      Revise
                    </button>
                    <button
                      onClick={handleGhostExecute}
                      className="flex-1 py-3 bg-xmr-accent text-xmr-base font-black uppercase tracking-widest text-[9px] cursor-pointer hover:bg-xmr-green transition-colors flex items-center justify-center gap-2"
                    >
                      <Ghost size={14} /> Execute Ghost Send
                    </button>
                  </div>
                </div>
              )}

              {(ghostPhase === 'creating' || ghostPhase === 'sending') && (
                <div className="py-16 flex flex-col items-center gap-4 text-xmr-accent/60">
                  <Loader2 size={32} className="animate-spin" />
                  <span className="text-[9px] uppercase font-mono tracking-widest animate-pulse">
                    {ghostPhase === 'creating' ? 'Creating trade...' : 'Dispatching XMR to relay...'}
                  </span>
                </div>
              )}

              {ghostPhase === 'tracking' && (
                <div className="py-8 flex flex-col items-center gap-4">
                  <RefreshCw size={32} className="text-xmr-accent animate-spin" />
                  <div className="text-sm uppercase text-xmr-accent font-black">Ghost Protocol Active</div>
                  <div className="text-[9px] text-xmr-dim uppercase tracking-widest">
                    Status: <span className="text-xmr-green">{tradeStatus}</span>
                  </div>
                  {tradeResponse && (
                    <div className="w-full bg-xmr-base border border-xmr-border p-3 mt-2 text-[8px] font-mono text-xmr-dim space-y-1">
                      <div>Trade ID: <span className="text-xmr-green">{tradeResponse.trade_id || tradeResponse.id}</span></div>
                      <div>Deposit: <span className="text-xmr-green">{tradeResponse.deposit_amount || tradeResponse.amount_from} XMR</span></div>
                      <div>Receiving: <span className="text-xmr-green">{tradeResponse.amount_to} {tradeResponse.ticker_to?.toUpperCase()}</span></div>
                    </div>
                  )}
                  <div className="text-[8px] text-xmr-dim opacity-50 uppercase">Polling every 10s...</div>
                </div>
              )}

              {ghostPhase === 'complete' && (
                <div className="py-12 flex flex-col items-center gap-4 text-center">
                  <CheckCircle2 size={48} className="text-xmr-green" />
                  <div className="text-sm uppercase text-xmr-green font-black">Ghost Send Complete</div>
                  <div className="text-[9px] text-xmr-dim uppercase">
                    {tradeResponse?.amount_to} {tradeResponse?.ticker_to?.toUpperCase()} delivered
                  </div>
                  <button onClick={onClose} className="mt-4 px-6 py-2 bg-xmr-green text-xmr-base text-[10px] uppercase tracking-widest cursor-pointer">Close</button>
                </div>
              )}

              {ghostPhase === 'error' && (
                <div className="py-12 flex flex-col items-center gap-4 text-center">
                  <AlertTriangle size={48} className="text-red-500" />
                  <div className="text-sm uppercase text-red-500 font-black">Ghost Send Failed</div>
                  <div className="text-[9px] text-xmr-dim">{ghostError}</div>
                  <button onClick={resetGhost} className="mt-4 px-6 py-2 border border-xmr-border text-xmr-dim text-[10px] uppercase tracking-widest cursor-pointer hover:border-xmr-accent">Retry</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
