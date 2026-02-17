import React, { createContext, useContext, useState, useEffect } from 'react';

interface TorContextType {
  useTor: boolean;
  setUseTor: (v: boolean) => void;
  torFetch: (url: string, options?: any) => Promise<any>;
}

const TorContext = createContext<TorContextType | undefined>(undefined);

export function TorProvider({ children }: { children: React.ReactNode }) {
  const [useTor, _setUseTor] = useState(true); // 🛡️ Privacy-first default

  useEffect(() => {
    // Load initial config
    window.api.getConfig('use_tor').then((v: boolean) => {
      // If user has explicitly disabled it, honor that. Otherwise (true/undefined) keep true.
      _setUseTor(v !== false);
    });
  }, []);

  const setUseTor = (v: boolean) => {
    _setUseTor(v);
    window.api.setConfig('use_tor', v);
  };

  const torFetch = async (url: string, options: any = {}) => {
    const { method = 'GET', body, headers = {} } = options;
    const result = await window.api.proxyRequest({
      url,
      method,
      data: body ? JSON.parse(body) : undefined,
      headers,
      useTor
    });
    
    if (result.error) throw new Error(result.error);
    return result.data;
  };

  return (
    <TorContext.Provider value={{ useTor, setUseTor, torFetch }}>
      {children}
    </TorContext.Provider>
  );
}

export function useTor() {
  const context = useContext(TorContext);
  if (!context) throw new Error('useTor must be used within TorProvider');
  return context;
}
