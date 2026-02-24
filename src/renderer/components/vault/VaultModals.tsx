import React, { useState, useEffect } from 'react';
import { X, ShieldAlert } from 'lucide-react';
import { ReceiveModal } from './ReceiveModal';
import { DispatchModal } from './DispatchModal';

interface VaultModalsProps {
  // Seed Modal
  showSeed: boolean;
  onCloseSeed: () => void;
  mnemonic: string;
  
  // Receive Modal
  showReceive: boolean;
  onCloseReceive: () => void;
  onCreateSub: (label: string) => void;
  selectedSubaddress?: { address: string; label: string; index: number } | null;
  
  // Send Modal
  showSend: boolean;
  onCloseSend: () => void;
  onSend: (address: string, amount: number) => void;
  isSending: boolean;
  initialAddr?: string;
  sourceSubaddressIndex?: number;
}

export function VaultModals({ 
  showSeed, onCloseSeed, mnemonic,
  showReceive, onCloseReceive, onCreateSub, selectedSubaddress,
  showSend, onCloseSend, onSend, isSending,
  initialAddr = '', sourceSubaddressIndex
}: VaultModalsProps) {

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
        <ReceiveModal
          onClose={onCloseReceive}
          existingAddress={selectedSubaddress || undefined}
        />
      )}

      {/* DISPATCH MODAL */}
      {showSend && (
        <DispatchModal
          onClose={onCloseSend}
          initialAddress={initialAddr}
          sourceSubaddressIndex={sourceSubaddressIndex}
        />
      )}
    </>
  );
}
