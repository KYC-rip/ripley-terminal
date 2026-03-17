import type { ReactNode } from 'react';

interface TableHeaderProps {
  children: ReactNode;
}

export function TableHeader({ children }: TableHeaderProps) {
  return (
    <div className="px-4 py-3 border-b border-xmr-border/20 bg-xmr-green/5 text-[11px] font-black uppercase tracking-widest flex justify-between items-center shrink-0">
      {children}
    </div>
  );
}
