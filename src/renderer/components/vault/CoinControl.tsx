import React from 'react';
import { Coins, Shield, Lock as LockIcon } from 'lucide-react';
import { Card } from '../Card';

interface CoinControlProps {
  outputs: any[];
}

export function CoinControl({ outputs }: CoinControlProps) {
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
              <th className="px-4 py-2">Amount</th>
              <th className="px-4 py-2">Key_Image_Preview</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="text-[10px] font-black divide-y divide-xmr-border/5">
            {outputs.map((o: any, i: number) => (
              <tr key={i} className="hover:bg-xmr-green/5 transition-colors">
                <td className="px-4 py-3">
                  {o.isUnlocked ? (
                    <span className="flex items-center gap-1 text-xmr-green"><Shield size={10}/> UNLOCKED</span>
                  ) : (
                    <span className="flex items-center gap-1 text-xmr-dim opacity-50"><LockIcon size={10}/> FROZEN</span>
                  )}
                </td>
                <td className="px-4 py-3 text-xmr-green">{o.amount} XMR</td>
                <td className="px-4 py-3 font-mono text-[8px] opacity-40 uppercase">{o.keyImage?.substring(0, 24)}...</td>
                <td className="px-4 py-3 text-right">
                  <button disabled={!o.isUnlocked} className="text-[8px] px-2 py-1 border border-xmr-border hover:bg-xmr-green hover:text-xmr-base transition-all uppercase disabled:opacity-30">Vanish</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
