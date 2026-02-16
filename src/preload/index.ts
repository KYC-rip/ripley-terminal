import { contextBridge, ipcRenderer } from 'electron';

// Explicitly define the API to ensure no method is lost during serialization
const api = {
  getEnv: () => ipcRenderer.invoke('get-env'),
  getSeed: () => ipcRenderer.invoke('get-seed'),
  saveSeed: (seed: string) => ipcRenderer.invoke('save-seed', seed),
  burnIdentity: () => ipcRenderer.invoke('burn-identity'),
  getConfig: (key: string) => ipcRenderer.invoke('get-config', key),
  setConfig: (key: string, value: any) => ipcRenderer.invoke('set-config', key, value),
  getUplinkStatus: () => ipcRenderer.invoke('get-uplink-status'),
  proxyRequest: (params: any) => ipcRenderer.invoke('proxy-request', params),
  onTorStatus: (callback: (msg: string) => void) => {
    const subscription = (_event: any, msg: string) => callback(msg);
    ipcRenderer.on('tor-status', subscription);
    return () => ipcRenderer.removeListener('tor-status', subscription);
  }
};

try {
  contextBridge.exposeInMainWorld('api', api);
  console.log('Tactical API Injected Successfully');
} catch (error) {
  console.error('Failed to inject API:', error);
}
