import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Info, X } from 'lucide-react';

interface ExplainerCardProps {
  title: React.ReactNode;
  description: React.ReactNode;
  children: React.ReactNode;
  storageKey: string;
  className?: string;
}

export const ExplainerCard: React.FC<ExplainerCardProps> = ({ title, description, children, storageKey, className = '' }) => {
  const [isVisible, setIsVisible] = useState(() => {
    return localStorage.getItem(`hide_explainer_${storageKey}`) !== 'true';
  });

  const handleClose = () => {
    setIsVisible(false);
    localStorage.setItem(`hide_explainer_${storageKey}`, 'true');
  };

  const handleToggle = () => setIsVisible(!isVisible);

  return (
    <div className={`my-2 w-full ${className}`}>
      {!isVisible && (
        <button 
          onClick={handleToggle}
          className="flex items-center gap-2 text-xmr-dim hover:text-xmr-green transition-colors text-xs font-mono mb-2 cursor-pointer"
        >
          <Info size={14} />
          <span>HOW IT WORKS</span>
        </button>
      )}

      <AnimatePresence>
        {isVisible && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden mb-4"
          >
            <div className="relative w-full rounded-sm border border-xmr-border bg-xmr-surface p-1 overflow-hidden">
              {/* Header Bar */}
              <div className="flex justify-between items-center px-3 py-2 border-b border-xmr-border bg-xmr-base/50 mb-1">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-xmr-green animate-pulse" />
                  <span className="text-xs font-mono text-xmr-green tracking-wider uppercase">
                    {title}
                  </span>
                </div>
                <button 
                  onClick={handleClose}
                  className="text-xmr-dim hover:text-xmr-accent transition-colors cursor-pointer"
                >
                  <X size={14} />
                </button>
              </div>

              {/* Animation Canvas */}
              <div className="relative w-full h-40 bg-xmr-base flex items-center justify-center overflow-hidden border border-xmr-border/30 rounded-sm">
                {children}
                
                {/* Scanline overlay */}
                <div className="absolute inset-0 pointer-events-none opacity-20 bg-[linear-gradient(rgba(18,16,16,0)_50%,rgba(0,0,0,0.25)_50%),linear-gradient(90deg,rgba(255,0,0,0.06),rgba(0,255,0,0.02),rgba(0,0,255,0.06))]" style={{ backgroundSize: "100% 2px, 3px 100%" }} />
              </div>

              {/* Footer Description */}
              <div className="p-3 bg-xmr-base/30">
                <p className="text-xs font-mono text-xmr-dim leading-relaxed text-left">
                  {description}
                </p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};