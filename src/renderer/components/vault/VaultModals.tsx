import React, { useState, useEffect } from 'react';
import { X, ShieldAlert, Key, Tag, PlusCircle, Send, Skull } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { Card } from '../Card';

interface VaultModalsProps {
  // Seed Modal
  showSeed: boolean;
  onCloseSeed: () => void;
  mnemonic: string;
  
  // Receive Modal
  showReceive: boolean;
  onCloseReceive: () => void;
  onCreateSub: (label: string) => void;
  
  // Send Modal
  showSend: boolean;
  onCloseSend: () => void;
  onSend: (address: string, amount: number) => void;
  isSending: boolean;
  torFetch: any;
  initialAddr?: string;
}

export function VaultModals({ 
  showSeed, onCloseSeed, mnemonic,
  showReceive, onCloseReceive, onCreateSub,
  showSend, onCloseSend, onSend, isSending, torFetch,
  initialAddr = ''
}: VaultModalsProps) {
  
  // Receive Modal Local State
  const [receiveLabel, setReceiveLabel] = useState('');

  // Send Modal Local State
  const [destAddr, setDestAddr] = useState(initialAddr);
  const [sendAmount, setAmount] = useState('');
  const [isBanned, setIsBanned] = useState(false);

  useEffect(() => { if (showSend) setDestAddr(initialAddr); }, [showSend, initialAddr]);

  // Ban check logic
  useEffect(() => {
    if (destAddr.length > 30) {
      torFetch(`https://api.kyc.rip/v1/tools/ban-list?address=${destAddr}`)
        .then((data: any) => setIsBanned(data.results && data.results.length > 0))
        .catch(() => setIsBanned(false));
    } else setIsBanned(false);
  }, [destAddr, torFetch]);

  return (
    <>
      {/* SEED MODAL */}
      {showSeed && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in fade-in duration-300">
          <div className="w-full max-w-lg bg-white text-black p-8 border-4 border-red-600 relative">
            <button onClick={onCloseSeed} className="absolute top-4 right-4 cursor-pointer"><X size={24} /></button>
            <div className="space-y-6 font-black">
              <div className="flex items-center gap-3 text-red-600 animate-pulse font-black"><ShieldAlert size={32} /><h3 className="text-2xl font-black uppercase tracking-tighter">Backup_Protocol</h3></div>
              <div className="p-4 bg-black/5 border border-black/10 rounded-sm font-black text-sm leading-loose select-text text-black">{mnemonic}</div>
              <button onClick={onCloseSeed} className="w-full py-4 bg-black text-white font-black uppercase tracking-[0.2em] font-mono cursor-pointer">I_HAVE_SECURED_THE_KEY</button>
            </div>
          </div>
        </div>
      )}

      {/* RECEIVE MODAL */}
      {showReceive && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
          <div className="w-full max-w-md bg-xmr-surface border border-xmr-border p-8 space-y-8 relative font-black">
            <button onClick={onCloseReceive} className="absolute top-4 right-4 text-xmr-dim hover:text-xmr-green transition-all cursor-pointer"><X size={24} /></button>
            <div className="text-center space-y-2">
              <h3 className="text-2xl font-black italic uppercase text-xmr-green">Forced_Subaddress</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">Breaking linkability via fresh entropy</p>
            </div>
            <div className="space-y-6">
              <div className="space-y-2">
                 <label className="text-[9px] font-black text-xmr-dim uppercase ml-1 flex items-center gap-2"><Tag size={10}/> Metadata_Label</label>
                 <input autoFocus type="text" value={receiveLabel} onChange={(e) => setReceiveLabel(e.target.value)} placeholder="e.g. From_Exchange_A" className="w-full bg-xmr-base border border-xmr-border p-3 text-[11px] text-xmr-green focus:border-xmr-green outline-none" />
              </div>
              <button onClick={() => { onCreateSub(receiveLabel); setReceiveLabel(''); }} className="w-full py-4 bg-xmr-green text-xmr-base font-black uppercase tracking-[0.2em] hover:bg-white transition-all flex items-center justify-center gap-2 font-black cursor-pointer"><PlusCircle size={16}/> Generate_One_Time_Uplink</button>
            </div>
          </div>
        </div>
      )}

      {/* SEND MODAL */}
      {showSend && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-xmr-base/90 backdrop-blur-md animate-in zoom-in-95 duration-300 font-black">
          <div className="w-full max-w-lg bg-xmr-surface border border-xmr-accent/50 p-8 space-y-6 relative font-black">
            <button onClick={onCloseSend} className="absolute top-4 right-4 text-xmr-dim hover:text-xmr-green cursor-pointer"><X size={24} /></button>
            <div className="text-center space-y-2 mb-4 font-black">
              <h3 className="text-2xl font-black italic uppercase text-xmr-accent">Dispatch_Sequence</h3>
              <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">Constructing outbound transaction</p>
            </div>
            <div className="space-y-4 font-black">
              <div className="space-y-1 font-black">
                 <div className="flex justify-between items-center font-black">
                    <label className="text-[9px] font-black text-xmr-dim uppercase font-black">Destination_Address</label>
                    {isBanned && <span className="text-[8px] text-red-500 font-black animate-pulse uppercase tracking-tighter">Intercepted</span>}
                 </div>
                 <input type="text" placeholder="4... / 8..." value={destAddr} onChange={(e) => setDestAddr(e.target.value)} className={`w-full bg-xmr-base border p-3 text-[10px] text-xmr-green focus:border-xmr-accent outline-none font-black transition-colors ${isBanned ? 'border-red-600' : 'border-xmr-border'}`} />
              </div>
              <div className="space-y-1 font-black">
                 <label className="text-[9px] font-black text-xmr-dim uppercase font-black">Amount (XMR)</label>
                 <input type="number" placeholder="0.00" value={sendAmount} onChange={(e) => setAmount(e.target.value)} className="w-full bg-xmr-base border border-xmr-border p-3 text-2xl font-black text-xmr-accent focus:border-xmr-accent outline-none font-black" />
              </div>
              <button disabled={isSending || isBanned} onClick={() => onSend(destAddr, parseFloat(sendAmount))} className={`w-full py-4 font-black uppercase tracking-[0.3em] transition-all flex items-center justify-center gap-3 mt-4 font-black cursor-pointer ${isBanned ? 'bg-red-950 text-red-500 cursor-not-allowed' : 'bg-xmr-accent text-xmr-base hover:bg-xmr-green hover:text-xmr-base'}`}><Send size={18} /> {isSending ? 'DISPATCHING...' : isBanned ? 'MISSION_ABORTED' : 'CONFIRM_DISPATCH'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
