interface SpinnerProps {
  size?: 'sm' | 'md';
  className?: string;
}

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  const sizeClass = size === 'sm' ? 'w-4 h-4' : 'w-6 h-6';
  return (
    <div className={`${sizeClass} border-2 border-xmr-green border-t-transparent rounded-full animate-spin ${className}`} />
  );
}
