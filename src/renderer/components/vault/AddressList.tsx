import React from 'react';
import { Copy } from 'lucide-react';
import { Card } from '../Card';

interface AddressListProps {
  subaddresses: any[];
  handleCopy: (text: string) => void;
}

export function AddressList({ subaddresses, handleCopy }: AddressListProps) {
  return (
    <Card noPadding className="h-[400px] flex flex-col">
      <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[9px] font-black uppercase tracking-widest flex justify-between items-center shrink-0">
        <span>Internal_Subaddresses</span>
        <span className="opacity-40">{subaddresses?.length || 0} Entries</span>
      </div>
      <div className="flex-grow overflow-y-auto custom-scrollbar">
        <table className="w-full text-left">
          <thead className="text-[8px] text-xmr-dim border-b border-xmr-border/10 sticky top-0 bg-xmr-surface uppercase">
            <tr>
              <th className="px-4 py-2">Index</th>
              <th className="px-4 py-2">Label</th>
              <th className="px-4 py-2">Address</th>
              <th className="px-4 py-2 text-right">Balance</th>
            </tr>
          </thead>
          <tbody className="text-[10px] font-black divide-y divide-xmr-border/5">
            {subaddresses.map((s: any) => (
              <tr key={s.index} className="hover:bg-xmr-green/5 transition-colors group">
                <td className="px-4 py-3 text-xmr-dim">#{s.index}</td>
                <td className="px-4 py-3 uppercase text-xmr-green/80">{s.label}</td>
                <td className="px-4 py-3 font-mono opacity-60">
                  <div className="flex items-center gap-2">
                    <span className="truncate max-w-[200px]">{s.address}</span>
                    <button 
                      onClick={() => handleCopy(s.address)} 
                      className="text-xmr-green opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    >
                      <Copy size={10}/>
                    </button>
                  </div>
                </td>
                <td className="px-4 py-3 text-right text-xmr-green">
                  {parseFloat(s.balance) > 0 ? s.balance : '--'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
