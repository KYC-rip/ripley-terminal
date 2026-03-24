import { useState, useEffect } from 'react';

export type ThemeMode = 'dark' | 'light' | 'system';
type ResolvedTheme = 'dark' | 'light';
type Contrast = 'default' | 'high';
export type Skin = 'terminal' | 'clean' | 'monero';

const SKIN_LABELS: Record<Skin, string> = {
  terminal: 'Terminal',
  clean: 'Clean',
  monero: 'Monero',
};

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem('theme-mode');
    return (saved === 'dark' || saved === 'light' || saved === 'system')
      ? (saved as ThemeMode)
      : 'system'; // Follow OS preference by default
  });

  const [contrast, setContrast] = useState<Contrast>(() => {
    const saved = localStorage.getItem('contrast');
    if (saved === 'high' || saved === 'default') return saved as Contrast;
    return 'default';
  });

  const [skin, setSkinState] = useState<Skin>(() => {
    const saved = localStorage.getItem('theme-skin');
    if (saved === 'terminal' || saved === 'clean' || saved === 'monero') return saved;
    return 'terminal';
  });

  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>('dark');

  useEffect(() => {
    const root = window.document.documentElement;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

    const applyTheme = (targetTheme: ResolvedTheme) => {
      setResolvedTheme(targetTheme);
      root.classList.remove('light', 'dark');
      root.classList.add(targetTheme);
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

  // Apply contrast
  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.toggle('high-contrast', contrast === 'high');
    localStorage.setItem('contrast', contrast);
  }, [contrast]);

  // Apply skin
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('skin-terminal', 'skin-clean', 'skin-monero');
    root.classList.add(`skin-${skin}`);
    localStorage.setItem('theme-skin', skin);
  }, [skin]);

  const cycleTheme = () => {
    setModeState(prev => {
      if (prev === 'system') return 'light';
      if (prev === 'light') return 'dark';
      return 'system';
    });
  };

  const toggleContrast = () => setContrast(prev => prev === 'default' ? 'high' : 'default');

  const cycleSkin = () => {
    setSkinState(prev => prev === 'terminal' ? 'clean' : prev === 'clean' ? 'monero' : 'terminal');
  };

  return {
    mode, resolvedTheme, cycleTheme,
    contrast, toggleContrast,
    skin, skinLabel: SKIN_LABELS[skin], cycleSkin,
  };
}
