import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Shield, Lock, X, Zap, Bot, ExternalLink, ChevronRight, AlertCircle, Copy, Check } from 'lucide-react';
import { useVault } from '../../hooks/useVault';

export const XMR402Modal: React.FC = () => {
  const { monero402Challenge, clearMonero402Challenge, balance, isStagenet } = useVault();
  const [password, setPassword] = useState('');
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{ txid: string, proof: string } | null>(null);
  const [copiedTxid, setCopiedTxid] = useState(false);
  const [copiedProof, setCopiedProof] = useState(false);

  if (!monero402Challenge) return null;

  const { id, address, amount, message, type, returnUrl } = monero402Challenge;

  const handleAuthorize = async () => {
    setIsProcessing(true);
    setError(null);
    try {
      if (type === 'agent') {
        const res = await window.api.authorizeXmr402(id, password);
        if (res.success) {
          clearMonero402Challenge();
        } else {
          setError(res.error || 'Authorization failed.');
        }
      } else {
        // Handle Deep Link Flow
        const amountAtomic = (parseFloat(amount) * 1e12).toFixed(0);
        
        // 1. Execute XMR Transfer
        const txRes = await window.api.sendXmr(address, amountAtomic);
        if (!txRes.success) throw new Error(txRes.error || 'Transaction failed');
        
        // 2. Generate Proof using nonce
        const proofRes = await window.api.getTxProof(txRes.txid || '', address, message);
        if (!proofRes.success) throw new Error(proofRes.error || 'Proof generation failed');

        // 3. Handle Transparent Handback or Fallback to Success View
        if (returnUrl) {
          try {
            const callbackUrl = new URL(decodeURIComponent(returnUrl));
            callbackUrl.searchParams.set('xmr402_txid', txRes.txid || '');
            callbackUrl.searchParams.set('xmr402_proof', proofRes.signature || '');
            
            await window.api.openExternal(callbackUrl.toString());
            clearMonero402Challenge();
          } catch (e) {
            console.error('Invalid return_url:', returnUrl);
            setSuccessData({ txid: txRes.txid || '', proof: proofRes.signature || '' });
          }
        } else {
          setSuccessData({
            txid: txRes.txid || '',
            proof: proofRes.signature || ''
          });
        }
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsProcessing(false);
    }
  };

  const copyToClipboard = (text: string, type: 'txid' | 'proof') => {
    navigator.clipboard.writeText(text);
    if (type === 'txid') setCopiedTxid(true);
    if (type === 'proof') setCopiedProof(true);
    setTimeout(() => {
      if (type === 'txid') setCopiedTxid(false);
      if (type === 'proof') setCopiedProof(false);
    }, 2000);
  };

  const handleDeny = async () => {
    if (type === 'agent') {
      await window.api.authorizeXmr402(id, null);
    }
    clearMonero402Challenge();
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-md p-6 font-mono"
      >
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 20 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.9, opacity: 0, y: 20 }}
          className="w-full max-w-lg bg-xmr-base border border-xmr-accent/30 shadow-[0_0_50px_rgba(0,255,65,0.1)] overflow-hidden"
        >
          {/* Header */}
          <div className="bg-xmr-accent/10 border-b border-xmr-accent/20 p-4 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-xmr-accent/20 rounded-sm">
                <Shield size={20} className="text-xmr-accent" />
              </div>
              <div>
                <h2 className="text-sm font-black uppercase tracking-[0.2em] text-xmr-accent italic">Authorization_Required</h2>
                <p className="text-[10px] text-xmr-dim uppercase tracking-widest font-black">XMR402 // Tactical Execution Request</p>
              </div>
            </div>
            <button onClick={handleDeny} className="text-xmr-dim hover:text-red-500 transition-colors cursor-pointer">
              <X size={20} />
            </button>
          </div>

          <div className="p-8 space-y-6">
            {/* Origin Info */}
            <div className="flex items-center gap-4 p-4 bg-xmr-surface border border-xmr-border/40 rounded-sm">
              <div className="w-12 h-12 flex items-center justify-center bg-xmr-base border border-xmr-green/20 rounded-full">
                {type === 'agent' ? <Bot size={24} className="text-xmr-green" /> : <ExternalLink size={24} className="text-xmr-accent" />}
              </div>
              <div className="flex-grow">
                <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Request_Origin</div>
                <div className="text-xs text-xmr-green font-black uppercase tracking-wider">
                  {type === 'agent' ? 'Ripley_AI_Gateway (LOCAL)' : 'Protocol_Deep_Link'}
                </div>
              </div>
              <div className="text-right">
                <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Network</div>
                <div className={`text-[10px] font-black uppercase ${isStagenet ? 'text-orange-500' : 'text-xmr-green'}`}>
                  {isStagenet ? 'STAGENET' : 'MAINNET'}
                </div>
              </div>
            </div>

            {/* Transaction Data */}
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-xmr-surface border border-xmr-border/40">
                <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest mb-1">Target_Address</div>
                <div className="text-[11px] text-xmr-green font-mono break-all leading-tight opacity-80">
                  {address.substring(0, 16)}...{address.substring(address.length - 12)}
                </div>
              </div>
              <div className="p-4 bg-xmr-surface border border-xmr-border/40">
                <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest mb-1">Settlement_Amount</div>
                <div className="text-xl font-black text-xmr-accent italic flex items-baseline gap-1">
                  {amount} <span className="text-[10px] not-italic text-xmr-dim">XMR</span>
                </div>
              </div>
            </div>

            {/* Nonce / Proof Info */}
            <div className="p-4 bg-xmr-surface border border-xmr-border/40">
              <div className="flex items-center gap-2 mb-2">
                <Zap size={12} className="text-xmr-green" />
                <span className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">XMR402_Nonce (Reference)</span>
              </div>
              <div className="bg-xmr-base p-2 text-[10px] font-mono text-xmr-dim break-all border border-xmr-border/20">
                {message || 'NO_NONCE_PROVIDED'}
              </div>
              <p className="text-[9px] text-xmr-dim/60 uppercase mt-2 leading-relaxed">
                This nonce will be cryptographically signed into the transaction proof to verify payment for this specific session.
              </p>
            </div>

            {successData ? (
              <div className="space-y-4 animate-in fade-in duration-500">
                <div className="flex items-center justify-center p-4 bg-xmr-green/10 border border-xmr-green rounded-sm mb-4">
                  <div className="flex flex-col items-center">
                    <Check size={32} className="text-xmr-green mb-2" />
                    <span className="text-xs font-black uppercase text-xmr-green tracking-widest">Protocol_Excuted_Successfully</span>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div className="p-4 bg-xmr-surface border border-xmr-border/40 relative">
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Transaction_Hash (TXID)</div>
                      <button onClick={() => copyToClipboard(successData.txid, 'txid')} className="text-xmr-dim hover:text-xmr-green transition-colors flex items-center gap-1 cursor-pointer">
                        {copiedTxid ? <Check size={12} className="text-xmr-green" /> : <Copy size={12} />}
                        <span className={`text-[9px] uppercase font-black ${copiedTxid ? 'text-xmr-green' : ''}`}>{copiedTxid ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <div className="text-[11px] text-xmr-green font-mono break-all leading-tight opacity-80 bg-xmr-base p-2 border border-xmr-border/20">
                      {successData.txid}
                    </div>
                  </div>

                  <div className="p-4 bg-xmr-surface border border-xmr-border/40 relative">
                    <div className="flex justify-between items-center mb-1">
                      <div className="text-[10px] text-xmr-dim uppercase font-black tracking-widest">Cryptographic_Proof</div>
                      <button onClick={() => copyToClipboard(successData.proof, 'proof')} className="text-xmr-dim hover:text-xmr-green transition-colors flex items-center gap-1 cursor-pointer">
                        {copiedProof ? <Check size={12} className="text-xmr-green" /> : <Copy size={12} />}
                        <span className={`text-[9px] uppercase font-black ${copiedProof ? 'text-xmr-green' : ''}`}>{copiedProof ? 'Copied' : 'Copy'}</span>
                      </button>
                    </div>
                    <div className="text-[11px] text-xmr-green font-mono break-all leading-tight opacity-80 bg-xmr-base p-2 border border-xmr-border/20 h-24 overflow-y-auto">
                      {successData.proof}
                    </div>
                  </div>
                </div>

                <div className="pt-4">
                  <button
                    onClick={handleDeny}
                    className="w-full py-4 border border-xmr-green text-xmr-green font-black uppercase text-xs tracking-widest hover:bg-xmr-green hover:text-xmr-base transition-all cursor-pointer shadow-[0_0_15px_rgba(0,255,65,0.1)]"
                  >
                    Acknowledge_And_Close
                  </button>
                </div>
              </div>
            ) : (
              <>
                {/* Auth Input */}
                <div className="space-y-3">
                  <div className="flex justify-between items-center text-[10px] font-black uppercase tracking-widest text-xmr-dim">
                    <span>Vault_Access_Token</span>
                    <span>Wallet_Balance: {balance.total} XMR</span>
                  </div>
                  <div className="relative group">
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                      <Lock size={14} className="text-xmr-dim group-focus-within:text-xmr-green" />
                    </div>
                    <input
                      type="password"
                      autoFocus
                      placeholder="ENTER_VAULT_PASSWORD_TO_SIGN"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleAuthorize()}
                      className="w-full bg-xmr-surface border border-xmr-border p-4 pl-12 text-xs text-xmr-green font-black outline-none focus:border-xmr-green transition-all"
                    />
                  </div>
                  {error && (
                    <div className="flex items-center gap-2 text-red-500 text-[10px] font-black uppercase italic animate-pulse">
                      <AlertCircle size={12} /> {error}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="pt-2 flex gap-4">
                  <button
                    disabled={!password || isProcessing}
                    onClick={handleAuthorize}
                    className="flex-grow py-4 bg-xmr-green text-xmr-base font-black uppercase text-xs tracking-[0.2em] hover:bg-white transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer shadow-[0_0_20px_rgba(0,255,65,0.2)]"
                  >
                    {isProcessing ? <RefreshCw size={16} className="animate-spin" /> : <ChevronRight size={16} />}
                    {isProcessing ? 'Generating_Cryptographic_Proof...' : 'Confirm_Execution'}
                  </button>
                  <button
                    onClick={handleDeny}
                    className="px-6 py-4 border border-xmr-border text-xmr-dim font-black uppercase text-xs tracking-widest hover:border-red-500 hover:text-red-500 transition-all cursor-pointer"
                  >
                    Deny
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="bg-xmr-base/50 p-3 text-center border-t border-xmr-border/20">
            <span className="text-[9px] text-xmr-dim font-black uppercase tracking-[0.3em] opacity-40 animate-pulse">
              Ripley_Tactical_Enclave // Secure_Signing_Environment
            </span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
};

const RefreshCw = ({ size, className }: { size?: number, className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size || 24}
    height={size || 24}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
    <path d="M21 3v5h-5" />
    <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
    <path d="M3 21v-5h5" />
  </svg>
);
