import React, { createContext, useContext, useState, useEffect } from 'react';

interface TorContextType {
  useTor: boolean;
  setUseTor: (v: boolean) => void;
  torFetch: (url: string, options?: any) => Promise<any>;
}

const TorContext = createContext<TorContextType | undefined>(undefined);

export function TorProvider({ children }: { children: React.ReactNode }) {
  const [useTor, _setUseTor] = useState(false);

  useEffect(() => {
    // Load initial config
    (window as any).api.getConfig('use_tor').then((v: boolean) => {
      if (v !== undefined) _setUseTor(v);
    });
  }, []);

  const setUseTor = (v: boolean) => {
    _setUseTor(v);
    (window as any).api.setConfig('use_tor', v);
  };

  const torFetch = async (url: string, options: any = {}) => {
    const { method = 'GET', body, headers = {} } = options;
    const result = await (window as any).api.proxyRequest({
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
