export interface IApi {
  // Config & Secrets
  getEnv: () => Promise<any>;
  getSeed: () => Promise<string>;
  saveSeed: (seed: string) => Promise<boolean>;
  burnIdentity: () => Promise<boolean>;
  getConfig: (key: string) => Promise<any>;
  setConfig: (key: string, value: any) => Promise<boolean>;

  // Identity Management
  getIdentities: () => Promise<any[]>;
  saveIdentities: (identities: any[]) => Promise<boolean>;
  getActiveIdentity: () => Promise<string>;
  setActiveIdentity: (id: string) => Promise<boolean>;
  renameIdentity: (id: string, name: string) => Promise<boolean>;

  // File System (Wallet Storage)
  getWalletPath: () => Promise<string>;
  readWalletFile: (filename: string) => Promise<Uint8Array[] | null>;
  writeWalletFile: (params: { filename: string; data: number[][] | Uint8Array[] | any }) => Promise<boolean>;

  // Networking
  getUplinkStatus: () => Promise<{ target: string; useTor: boolean; isTorReady: boolean; isStagenet: boolean }>;
  proxyRequest: (params: any) => Promise<any>;

  // Events
  onTorStatus: (callback: (msg: string) => void) => () => void;
}

declare global {
  interface Window {
    api: IApi;
  }
}
