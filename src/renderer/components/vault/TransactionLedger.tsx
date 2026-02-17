import React from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import { Card } from '../Card';

interface TransactionLedgerProps {
  txs: any[];
}

export function TransactionLedger({ txs }: TransactionLedgerProps) {
  return (
    <Card noPadding className="h-[400px] flex flex-col">
      <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0">
        <span>Transaction_History</span>
        <span className="opacity-40">{txs?.length || 0} Records</span>
      </div>
      <div className="flex-grow overflow-y-auto custom-scrollbar">
        {txs?.length > 0 ? (
          <table className="w-full text-left border-collapse">
            <thead className="text-[8px] text-xmr-dim border-b border-xmr-border/10 sticky top-0 bg-xmr-surface uppercase">
              <tr>
                <th className="px-4 py-2">Flow</th>
                <th className="px-4 py-2">Amount</th>
                <th className="px-4 py-2">Confirmations</th>
                <th className="px-4 py-2 text-right">Timestamp</th>
              </tr>
            </thead>
            <tbody className="text-[10px] font-black divide-y divide-xmr-border/5">
              {txs.map((tx: any, i: number) => (
                <tr key={i} className="hover:bg-xmr-green/5 transition-colors group">
                  <td className="px-4 py-3 flex items-center gap-2">
                    {tx.isIncoming ? (
                      <ArrowDownLeft size={14} className="text-xmr-green" />
                    ) : (
                      <ArrowUpRight size={14} className="text-xmr-accent" />
                    )} 
                    {tx.isIncoming ? 'IN' : 'OUT'}
                  </td>
                  <td className={`px-4 py-3 ${tx.isIncoming ? 'text-xmr-green' : 'text-xmr-accent'}`}>
                    {tx.isIncoming ? '+' : '-'}{tx.amount} XMR
                  </td>
                  <td className="px-4 py-3 opacity-60">[{tx.confirmations || 0}]</td>
                  <td className="px-4 py-3 text-right opacity-40 text-[9px]">
                    {new Date(tx.timestamp).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="h-full flex items-center justify-center italic opacity-20 uppercase text-[10px]">
            No_Ledger_Data
          </div>
        )}
      </div>
    </Card>
  );
}
