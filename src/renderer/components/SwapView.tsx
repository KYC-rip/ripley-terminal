import React, { useState, useEffect } from 'react';
import { ArrowDown, Zap, Shield, Ghost, RefreshCw, AlertCircle } from 'lucide-react';
import { CurrencySelector } from './CurrencySelector';
import { Card } from './Card';
import { useCurrencies, type Currency } from '../hooks/useCurrencies';
import { fetchBridgeEstimate, type BridgeEstimate } from '../services/swap';

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

  return (
    <div className="max-w-xl mx-auto py-10 space-y-6 animate-in fade-in slide-in-from-top-4 duration-500">
      <div className="text-center space-y-2 mb-10">
        <h2 className="text-3xl font-black italic uppercase text-[#ff6600]">Ghost_Swap</h2>
        <p className="text-[10px] text-xmr-dim uppercase tracking-[0.2em]">Aggregated Dark-Pool Routing via kyc.rip</p>
      </div>

      <Card className="p-6 bg-black/40 border-[#ff6600]/30 relative overflow-hidden">
        <div className="absolute top-0 right-0 p-2 opacity-10">
          <Zap size={40} className="text-[#ff6600]" />
        </div>

        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-[9px] font-bold text-xmr-dim uppercase ml-1">You_Send</label>
            <div className="flex gap-2 bg-black border border-[#004d13]/30 p-2 rounded-sm">
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
                className="flex-grow bg-transparent text-right text-xl font-bold focus:outline-none pr-4 text-white"
              />
            </div>
          </div>

          <div className="flex justify-center -my-2 relative z-10">
            <div className="bg-[#050505] border border-[#ff6600]/50 p-1 rounded-full text-[#ff6600]">
              <ArrowDown size={16} />
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[9px] font-bold text-xmr-dim uppercase ml-1">You_Receive_Anonymously</label>
            <div className="flex gap-2 bg-black border border-[#004d13]/30 p-2 rounded-sm opacity-80">
              <div className="w-32 p-2 flex items-center gap-2 font-bold text-xs uppercase">
                <Shield size={14} className="text-[#00ff41]" /> XMR
              </div>
              <div className="flex-grow text-right text-xl font-bold pr-4 text-[#00ff41]">
                {isQuoting ? '...' : (quote?.amount_to || '0.0000')}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-[#004d13]/20 space-y-4">
          <div className="space-y-1">
            <div className="flex justify-between">
              <label className="text-[9px] font-bold text-xmr-dim uppercase ml-1">Recipient_Address (Local_Vault)</label>
              <span className="text-[8px] text-[#00ff41] font-bold uppercase tracking-widest">[ AUTO_SYNCED ]</span>
            </div>
            <div className="mt-1 p-3 bg-[#00ff41]/5 border border-[#00ff41]/20 rounded-sm">
              <code className="text-[9px] text-[#00ff41] break-all leading-tight opacity-80">
                {localXmrAddress || 'WAITING_FOR_VAULT_UPLINK...'}
              </code>
            </div>
          </div>

          <button className="w-full py-4 bg-[#ff6600] text-black font-black uppercase tracking-[0.2em] hover:opacity-90 transition-all flex items-center justify-center gap-3 mt-4 group">
            <Ghost size={18} className="group-hover:animate-pulse" />
            Initiate_Vanish_Sequence
          </button>
        </div>
      </Card>

      <div className="p-4 bg-[#ff6600]/5 border border-[#ff6600]/20 rounded-sm flex gap-3">
        <AlertCircle size={16} className="text-[#ff6600] shrink-0 mt-0.5" />
        <p className="text-[9px] text-[#ff6600]/80 leading-relaxed uppercase">
          WARNING: This operation will bridge clear-net assets into your private vault. 
          The kyc.rip aggregator will ensure zero linkability between source and destination.
        </p>
      </div>
    </div>
  );
}
