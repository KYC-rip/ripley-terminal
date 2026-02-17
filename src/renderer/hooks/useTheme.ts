import { useState, useEffect } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
type ResolvedTheme = 'dark' | 'light';

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme-mode');
    return (saved === 'dark' || saved === 'light' || saved === 'system')
      ? (saved as ThemeMode)
      : 'dark'; // Desktop defaults to dark
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = (targetTheme: ResolvedTheme) => {
      setResolvedTheme(targetTheme);
      if (targetTheme === 'light') {
        root.classList.add('light');
        root.classList.remove('dark'); 
      } else {
        root.classList.remove('light');
        root.classList.add('dark'); 
      }
    };

    const handleSystemChange = () => {
      if (mode === 'system') {
        applyTheme(mediaQuery.matches ? 'dark' : 'light');
      }
    };

    if (mode === 'system') {
      applyTheme(mediaQuery.matches ? 'dark' : 'light');
      mediaQuery.addEventListener('change', handleSystemChange);
    } else {
      applyTheme(mode);
    }

    localStorage.setItem('theme-mode', mode);
    return () => mediaQuery.removeEventListener('change', handleSystemChange);
  }, [mode]);

  const cycleTheme = () => {
    setModeState(prev => {
      if (prev === 'system') return 'light';
      if (prev === 'light') return 'dark';
      return 'system';
    });
  };

  return { mode, resolvedTheme, cycleTheme };
}
