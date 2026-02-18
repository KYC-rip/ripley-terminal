import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // Config & Secrets
  getEnv: () => ipcRenderer.invoke('get-env'),
  getSeed: () => ipcRenderer.invoke('get-seed'),
  saveSeed: (seed: string) => ipcRenderer.invoke('save-seed', seed),
  burnIdentity: () => ipcRenderer.invoke('burn-identity'),
  getConfig: (key: string) => ipcRenderer.invoke('get-config', key),
  setConfig: (key: string, value: any) => ipcRenderer.invoke('set-config', key, value),
  
  // Identity Management
  getIdentities: () => ipcRenderer.invoke('get-identities'),
  saveIdentities: (identities: any[]) => ipcRenderer.invoke('save-identities', identities),
  getActiveIdentity: () => ipcRenderer.invoke('get-active-identity'),
  setActiveIdentity: (id: string) => ipcRenderer.invoke('set-active-identity', id),
  renameIdentity: (id: string, name: string) => ipcRenderer.invoke('rename-identity', { id, name }),

  // File System (Wallet Storage)
  getWalletPath: () => ipcRenderer.invoke('get-wallet-path'),
  readWalletFile: (filename: string) => ipcRenderer.invoke('read-wallet-file', filename),
  writeWalletFile: (params: { filename: string, data: Uint8Array | string }) => ipcRenderer.invoke('write-wallet-file', params),

  // Networking
  getUplinkStatus: () => ipcRenderer.invoke('get-uplink-status'),
  proxyRequest: (params: any) => ipcRenderer.invoke('proxy-request', params),
  
  // Events
  onTorStatus: (callback: (msg: string) => void) => {
    const subscription = (_event: any, msg: string) => callback(msg);
    ipcRenderer.on('tor-status', subscription);
    return () => ipcRenderer.removeListener('tor-status', subscription);
  },
  onVaultShutdown: (callback: () => void) => {
    ipcRenderer.on('vault-shutdown', () => callback());
  },
  confirmShutdown: () => ipcRenderer.send('confirm-shutdown')
};

try {
  contextBridge.exposeInMainWorld('api', api);
} catch (error) {
  console.error('Failed to inject API:', error);
}
