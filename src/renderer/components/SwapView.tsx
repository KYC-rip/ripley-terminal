import React, { useState, useEffect } from 'react';
import { ArrowDown, Zap, Shield, Ghost, RefreshCw, AlertCircle, Copy, Check, X, ArrowRight } from 'lucide-react';
import { CurrencySelector } from './CurrencySelector';
import { Card } from './Card';
import { useCurrencies, type Currency } from '../hooks/useCurrencies';
import { fetchBridgeEstimate, createBridgeTrade, type BridgeEstimate, type BridgeTrade } from '../services/swap';

interface SwapViewProps {
  localXmrAddress: string;
}

export function SwapView({ localXmrAddress }: SwapViewProps) {
  const { currencies } = useCurrencies();
  const [fromCoin, setFromCoin] = useState<Currency>(CurrencySelector.Monero);
  const [toCoin, setToCoin] = useState<Currency | null>(null);
  const [amount, setAmount] = useState('100');
  const [quote, setQuote] = useState<BridgeEstimate | null>(null);
  const [isQuoting, setIsQuoting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [activeTrade, setActiveTrade] = useState<BridgeTrade | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);

  // Initialize coins
  useEffect(() => {
    if (currencies.length > 0) {
      setFromCoin(currencies.find(c => c.ticker === 'USDT' && c.network === 'ethereum') || currencies[0]);
      setToCoin(currencies.find(c => c.ticker === 'XMR') || currencies[1]);
    }
  }, [currencies]);

  // Auto-quoting
  useEffect(() => {
    if (!fromCoin || !toCoin || !amount || parseFloat(amount) <= 0) return;
    
    const fetchQuote = async () => {
      setIsQuoting(true);
      try {
        const q = await fetchBridgeEstimate(
          fromCoin.ticker,
          toCoin.ticker,
          parseFloat(amount),
          fromCoin.network,
          toCoin.network,
          'ANY',
          'ANY'
        );
        setQuote(q);
      } catch (e) {
        console.error("Quote failed", e);
      } finally {
        setIsQuoting(false);
      }
    };

    const timer = setTimeout(fetchQuote, 500);
    return () => clearTimeout(timer);
  }, [fromCoin, toCoin, amount]);

  const handleSwap = async () => {
    if (!quote || !localXmrAddress || isCreating) return;
    
    setIsCreating(true);
    try {
      const trades = await createBridgeTrade({
        from_currency: fromCoin.ticker,
        from_network: fromCoin.network,
        to_currency: toCoin!.ticker,
        to_network: toCoin!.network,
        amount_from: parseFloat(amount),
        address_to: localXmrAddress,
        refund_address: '' 
      });
      
      if (trades && trades.length > 0) {
        setActiveTrade(trades[0]);
      }
    } catch (e: any) {
      alert(`SWAP_FAILED: ${e.message}`);
    } finally {
      setIsCreating(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 2000);
  };

  if (activeTrade) {
    return (
      <div className="max-w-xl mx-auto py-10 space-y-6 animate-in zoom-in-95 duration-300">
        <Card className="p-8 border-xmr-accent bg-xmr-surface relative overflow-hidden">
           <button onClick={() => setActiveTrade(null)} className="absolute top-4 right-4 text-xmr-dim hover:text-xmr-green transition-colors"><X size={20}/></button>
           <div className="text-center space-y-4 mb-8">
              <div className="flex justify-center"><div className="p-4 bg-xmr-accent/20 rounded-full text-xmr-accent animate-pulse"><Zap size={32} /></div></div>
              <h3 className="text-2xl font-black italic uppercase text-xmr-green">Awaiting_Deposit</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest">Send funds to the tactical relay address below</p>
           </div>

           <div className="space-y-6">
              <div className="p-4 bg-xmr-base border border-xmr-accent/30 rounded-sm space-y-3">
                 <div className="flex justify-between items-center text-[9px] font-bold text-xmr-dim uppercase">
                    <span>Deposit_Amount</span>
                    <span className="text-xmr-accent">{activeTrade.amount_from} {activeTrade.ticker_from}</span>
                 </div>
                 <div className="flex justify-between items-center gap-4">
                    <code className="text-xs text-xmr-green font-black break-all">{activeTrade.address_provider}</code>
                    <button onClick={() => handleCopy(activeTrade.address_provider || '')} className="text-xmr-accent shrink-0 hover:scale-110 transition-transform cursor-pointer">
                       {copyFeedback ? <Check size={16}/> : <Copy size={16}/>}
                    </button>
                 </div>
              </div>

              <div className="flex items-center gap-4 justify-between text-[10px] font-bold uppercase tracking-tighter">
                 <div className="flex flex-col gap-1">
                    <span className="text-xmr-dim">YOU_SEND</span>
                    <span className="text-xmr-green opacity-90">{activeTrade.amount_from} {activeTrade.ticker_from}</span>
                 </div>
                 <ArrowRight size={20} className="text-xmr-dim" />
                 <div className="flex flex-col gap-1 text-right">
                    <span className="text-xmr-dim">YOU_RECEIVE</span>
                    <span className="text-xmr-green">{activeTrade.amount_to} XMR</span>
                 </div>
              </div>

              <div className="pt-6 border-t border-xmr-border/20 flex flex-col items-center gap-4">
                 <div className="flex items-center gap-2 text-[9px] text-xmr-green animate-pulse font-black uppercase tracking-widest">
                    <RefreshCw size={12} className="animate-spin" /> Monitoring_Blockchain_For_Deposit...
                 </div>
                 <p className="text-[8px] text-xmr-dim text-center uppercase leading-relaxed max-w-xs mx-auto">
                    Once detected, the kyc.rip aggregator will route your assets through an anonymous dark pool and deliver XMR to your local vault.
                 </p>
              </div>
           </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto py-10 space-y-6 animate-in fade-in slide-in-from-top-4 duration-500">
      <div className="text-center space-y-2 mb-10">
        <h2 className="text-3xl font-black italic uppercase text-xmr-accent">Ghost_Swap</h2>
        <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Aggregated Dark-Pool Routing via kyc.rip</p>
      </div>

      <Card className="p-6 bg-xmr-surface border-xmr-accent/30 relative overflow-hidden shadow-xl shadow-black/20">
        <div className="absolute top-0 right-0 p-2 opacity-10">
          <Zap size={40} className="text-xmr-accent" />
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[9px] font-bold text-xmr-dim uppercase ml-1">You_Send</label>
            <div className="flex gap-2 bg-xmr-base border border-xmr-border/30 p-2 rounded-sm transition-colors focus-within:border-xmr-accent/50">
              <CurrencySelector 
                selected={fromCoin} 
                onSelect={setFromCoin} 
                currencies={currencies} 
                className="w-32 bg-transparent border-none"
              />
              <input 
                type="number" 
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="flex-grow bg-transparent text-right text-xl font-bold focus:outline-none pr-4 text-xmr-green"
              />
            </div>
          </div>

          <div className="flex justify-center -my-2 relative z-10">
            <div className="bg-xmr-base border border-xmr-accent/50 p-1 rounded-full text-xmr-accent shadow-lg shadow-black/40">
              <ArrowDown size={16} />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[9px] font-bold text-xmr-dim uppercase ml-1">You_Receive_Anonymously</label>
            <div className="flex gap-2 bg-xmr-base border border-xmr-border/30 p-2 rounded-sm opacity-80">
              <div className="w-32 p-2 flex items-center gap-2 font-bold text-xs uppercase text-xmr-green">
                <Shield size={14} className="text-xmr-green" /> XMR
              </div>
              <div className="flex-grow text-right text-xl font-bold pr-4 text-xmr-green">
                {isQuoting ? '...' : (quote?.amount_to || '0.0000')}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-xmr-border/20 space-y-4">
          <div className="space-y-1">
            <div className="flex justify-between">
              <label className="text-[9px] font-bold text-xmr-dim uppercase ml-1">Recipient_Address (Local_Vault)</label>
              <span className="text-[8px] text-xmr-green font-bold uppercase tracking-widest">[ AUTO_SYNCED ]</span>
            </div>
            <div className="mt-1 p-3 bg-xmr-green/5 border border-xmr-green/20 rounded-sm">
              <code className="text-[9px] text-xmr-green break-all leading-tight opacity-80 font-mono">
                {localXmrAddress || 'WAITING_FOR_VAULT_UPLINK...'}
              </code>
            </div>
          </div>

          <button 
            disabled={!quote || !localXmrAddress || isCreating}
            onClick={handleSwap}
            className="w-full py-4 bg-xmr-accent text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-xmr-green hover:text-xmr-base transition-all flex items-center justify-center gap-3 mt-4 group disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-xmr-accent/10 active:scale-[0.98] cursor-pointer"
          >
            <Ghost size={18} className={isCreating ? 'animate-spin' : 'group-hover:animate-pulse'} />
            {isCreating ? 'ENGINE_BOOTING...' : 'Initiate_Vanish_Sequence'}
          </button>
        </div>
      </Card>

      <div className="p-4 bg-xmr-accent/5 border border-xmr-accent/20 rounded-sm flex gap-3">
        <AlertCircle size={16} className="text-xmr-accent shrink-0 mt-0.5" />
        <p className="text-[9px] text-xmr-accent opacity-80 leading-relaxed uppercase">
          WARNING: This operation will bridge clear-net assets into your private vault. 
          The kyc.rip aggregator will ensure zero linkability between source and destination.
        </p>
      </div>
    </div>
  );
}
