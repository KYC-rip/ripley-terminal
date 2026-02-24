// src/main/types.ts

export interface AppConfig {
  routingMode: 'tor' | 'clearnet' | 'custom';
  useSystemProxy: boolean;        // The new toggle switch
  systemProxyAddress: string;     // The actual proxy address (e.g., '127.0.0.1:7890')
  network: 'mainnet' | 'stagenet' | 'testnet';
  customNodeAddress: string; // e.g.: 127.0.0.1:18081 or xxxx.onion:18081

  // Custom Skin properties
  skin_background?: string; // base64 string
  skin_opacity?: number;    // 0.0 to 1.0
  skin_style?: 'cover' | 'contain' | 'tile' | 'top-left';
}

export interface NodeList {
  [network: string]: {
    tor: string[];
    clearnet: string[];
  };
}

export interface WalletEventPayload {
  type: 'SYNC_UPDATE' | 'BALANCE_CHANGED';
  payload: any;
}