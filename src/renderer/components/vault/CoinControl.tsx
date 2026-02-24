import React, { useState } from 'react';
import { Coins, Shield, Lock as LockIcon, Wind } from 'lucide-react';
import { Card } from '../Card';
import { useVault } from '../../contexts/VaultContext';

interface CoinControlProps {
  outputs: any[];
}

export function CoinControl({ outputs }: CoinControlProps) {
  const { vanishCoin, status } = useVault();
  const isSyncing = status === 'SYNCING';
  const [vanishingId, setVanishingId] = useState<string | null>(null);

  const handleVanish = async (keyImage: string) => {
    try {
      setVanishingId(keyImage);
      await vanishCoin(keyImage);
    } catch (error) {
      console.error("Vanish Failed:", error);
    } finally {
      setVanishingId(null);
    }
  };

  return (
    <Card noPadding className="h-[400px] flex flex-col">
      <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2"><Coins size={12}/> <span>Deterministic_Outputs (UTXOs)</span></div>
        <span className="opacity-40">{outputs?.length || 0} Coins</span>
      </div>
      <div className="flex-grow overflow-y-auto custom-scrollbar">
        <table className="w-full text-left border-collapse">
          <thead className="text-[8px] text-xmr-dim border-b border-xmr-border/10 sticky top-0 bg-xmr-surface uppercase">
            <tr>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Amount</th>
              <th className="px-4 py-2 text-right">Key_Image_Preview</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-[10px] font-black divide-y divide-xmr-border/5">
            {outputs.map((o: any, i: number) => {
              const isProcessing = vanishingId === o.keyImage;

              return (
                <tr key={i} className={`hover:bg-xmr-green/5 transition-colors ${isProcessing ? 'opacity-50' : ''}`}>
                <td className="px-4 py-3">
                  {o.isUnlocked ? (
                    <span className="flex items-center gap-1 text-xmr-green"><Shield size={10}/> UNLOCKED</span>
                  ) : (
                    <span className="flex items-center gap-1 text-xmr-dim opacity-50"><LockIcon size={10}/> FROZEN</span>
                  )}
                </td>
                  <td className="px-4 py-3 text-right text-xmr-green">{o.amount} XMR</td>
                  <td className="px-4 py-3 text-right font-mono text-[8px] opacity-40 uppercase">{o.keyImage?.substring(0, 24)}...</td>
                <td className="px-4 py-3 text-right">
                    <div
                      className="inline-block relative group/tooltip"
                      title={
                        isSyncing ? "Wait for vault to sync before vanishing." :
                          !o.isUnlocked ? "Coin is frozen and cannot be vanished." :
                            "Vanish: Sweeps this individual coin back to your primary address to isolate it and improve privacy."
                      }
                    >
                      <button
                        onClick={() => handleVanish(o.keyImage)}
                        disabled={!o.isUnlocked || isSyncing || vanishingId !== null}
                        className="text-[8px] px-2 py-1 border border-xmr-border hover:bg-xmr-green/10 hover:border-xmr-green/50 transition-all uppercase disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-1 min-w-[60px]"
                      >
                        {isProcessing ? <Wind size={10} className="animate-spin" /> : 'Vanish'}
                      </button>
                    </div>
                </td>
              </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
