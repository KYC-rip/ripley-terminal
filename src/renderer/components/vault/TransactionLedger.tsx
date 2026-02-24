import React, { useState } from 'react';
import { ArrowDownLeft, ArrowUpRight, ChevronDown, ChevronUp, Copy, ExternalLink, Info } from 'lucide-react';
import { Card } from '../Card';
import { AddressDisplay } from '../common/AddressDisplay';
import { SubaddressInfo } from '../../contexts/VaultContext';

interface Transaction {
  id: string;
  amount: string;
  type: 'in' | 'out' | 'pending';
  timestamp: number;
  address: string;
  confirmations: number;
  fee?: string;
  height?: number;
  paymentId?: string;
  note?: string;
  unlockTime?: number;
  doubleSpendSeen?: boolean;
  destinations?: Array<{ address: string; amount: string }>;
}

interface TransactionLedgerProps {
  txs: Transaction[];
  subaddresses?: SubaddressInfo[];
}

function getRelativeTime(timestamp: number) {
  const diffInSeconds = Math.floor((Date.now() - timestamp) / 1000);
  if (diffInSeconds < 60) return `${diffInSeconds}s ago`;
  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) return `${diffInHours}h ago`;
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) return `${diffInDays}d ago`;
  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) return `${diffInMonths}mo ago`;
  return `${Math.floor(diffInDays / 365)}y ago`;
}

export function TransactionLedger({ txs, subaddresses = [] }: TransactionLedgerProps) {
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);

  const getSubaddressLabel = (addr: string) => {
    const match = subaddresses.find(s => s.address === addr);
    return match?.label || null;
  };

  const toggleExpand = (id: string) => {
    setExpandedTxId(expandedTxId === id ? null : id);
  };

  return (
    <Card noPadding className="h-[430px] flex flex-col">
      <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[11px] font-black uppercase tracking-widest flex justify-between items-center shrink-0">
        <div className="flex items-center gap-2">
          <span>Transaction_History</span>
          <Info size={10} className="text-xmr-green opacity-40" />
        </div>
        <span className="opacity-40">{txs?.length || 0} Records</span>
      </div>

      <div className="flex-grow overflow-y-auto custom-scrollbar">
        {txs?.length > 0 ? (
          <div className="flex flex-col divide-y divide-xmr-border/5">
            {/* Header */}
            <div className="text-xs text-xmr-dim border-b border-xmr-border/10 sticky top-0 bg-xmr-surface uppercase grid grid-cols-12 px-4 py-2 font-black z-10">
              <div className="col-span-3">Flow</div>
              <div className="col-span-4">Amount</div>
              <div className="col-span-2">Confirmations</div>
              <div className="col-span-3 text-right">Timestamp</div>
            </div>

            {txs.map((tx) => {
              const isExpanded = expandedTxId === tx.id;
              const isIncoming = tx.type === 'in';

              return (
                <div key={tx.id} className="flex flex-col transition-all duration-200">
                  <div
                    onClick={() => toggleExpand(tx.id)}
                    className={`grid grid-cols-12 px-4 py-3 items-center cursor-pointer hover:bg-xmr-green/5 transition-colors group ${isExpanded ? 'bg-xmr-green/5' : ''}`}
                  >
                    <div className="col-span-3 flex items-center gap-2 text-xs font-black">
                      {isIncoming ? (
                        <ArrowDownLeft size={14} className="text-xmr-green" />
                      ) : (
                        <ArrowUpRight size={14} className="text-xmr-accent" />
                      )} 
                      <span className={isIncoming ? 'text-xmr-green' : 'text-xmr-accent'}>
                        {tx.type.toUpperCase()}
                      </span>
                    </div>

                    <div className={`col-span-4 text-xs font-black ${isIncoming ? 'text-xmr-green' : 'text-xmr-accent'}`}>
                      {isIncoming ? '+' : '-'}{tx.amount} XMR
                    </div>

                    <div className="col-span-2 text-[11px] font-black opacity-30">
                      [{tx.confirmations}]
                    </div>

                    <div className="col-span-3 text-right opacity-40 text-[11px] font-black font-mono">
                      {getRelativeTime(tx.timestamp)}
                    </div>
                  </div>

                  {/* Expanded Details */}
                  {isExpanded && (
                    <div className="px-4 py-4 bg-xmr-green/5 dark:bg-black/40 border-t border-b border-xmr-green/10 space-y-4 animate-in fade-in slide-in-from-top-2 duration-300">
                      {/* TXID */}
                      <div className="space-y-1">
                        <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Transaction_ID</label>
                        <AddressDisplay address={tx.id} className="text-xmr-green" />
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        {/* Details Column 1 */}
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Block_Height</label>
                            <span className="text-xs font-mono font-black">{tx.height || 'Pending...'}</span>
                          </div>
                          {tx.fee && (
                            <div className="space-y-1">
                              <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Network_Fee</label>
                              <span className="text-xs font-mono font-black text-xmr-dim">{tx.fee} XMR</span>
                            </div>
                          )}
                          <div className="space-y-1">
                            <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Timestamp</label>
                            <span className="text-xs font-mono font-black">{new Date(tx.timestamp).toLocaleString()}</span>
                          </div>
                        </div>

                        {/* Details Column 2 */}
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Unlock_Time</label>
                            <span className={`text-xs font-mono font-black ${tx.confirmations < 10 ? 'text-xmr-accent' : 'text-xmr-green'}`}>
                              {tx.confirmations >= 10 ? 'SPENDABLE' : `${Math.max(0, 10 - tx.confirmations)} Blocks Locked`}
                            </span>
                          </div>
                          {tx.paymentId && (
                            <div className="space-y-1">
                              <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Payment_ID</label>
                              <span className="text-[11px] font-mono font-black break-all">{tx.paymentId}</span>
                            </div>
                          )}
                          {tx.doubleSpendSeen && (
                            <div className="space-y-1">
                              <label className="text-xs text-xmr-error uppercase font-black tracking-widest block">DoubleSpend_Alert</label>
                              <span className="text-xs font-black text-xmr-error animate-pulse">WARNING: CONFLICT DETECTED</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Destinations for OUT txs */}
                      {!isIncoming && (
                        <div className="space-y-2 border-t border-xmr-green/5 pt-3">
                          <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Outbound_To</label>
                          {tx.destinations && tx.destinations.length > 0 ? (
                            <div className="space-y-2">
                              {tx.destinations.map((dest, idx) => {
                                const label = getSubaddressLabel(dest.address);
                                return (
                                  <div key={idx} className="flex justify-between items-start gap-4">
                                    <div className="flex-grow flex flex-col">
                                      {label && (
                                        <span className="text-xs font-black text-xmr-green uppercase tracking-widest bg-xmr-green/10 self-start px-1.5 py-0.5 rounded-sm mb-1">
                                          {label}
                                        </span>
                                      )}
                                      <AddressDisplay address={dest.address} className="text-[11px]" />
                                    </div>
                                    <span className="text-xs font-black text-xmr-accent whitespace-nowrap mt-0.5">-{dest.amount} XMR</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : (
                            <div className="text-xs font-mono text-xmr-dim opacity-60 flex items-center gap-2">
                              <span>¿Unknown Destination?</span>
                              <span className="text-xs bg-xmr-dim/10 px-1 rounded uppercase tracking-tighter">Privacy Protected</span>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Fallback address for IN txs */}
                      {isIncoming && tx.address && (
                        <div className="space-y-2 border-t border-xmr-green/5 pt-3">
                          <label className="text-xs text-xmr-dim uppercase font-black tracking-widest block">Inbound_To</label>
                          <div className="flex flex-col">
                            {getSubaddressLabel(tx.address) && (
                              <span className="text-xs font-black text-xmr-green uppercase tracking-widest bg-xmr-green/10 self-start px-1.5 py-0.5 rounded-sm mb-1">
                                {getSubaddressLabel(tx.address)}
                              </span>
                            )}
                            <AddressDisplay address={tx.address} className="text-xmr-green text-[11px]" />
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="h-full flex items-center justify-center italic opacity-20 uppercase text-xs">
            No_Ledger_Data
          </div>
        )}
      </div>
    </Card>
  );
}
