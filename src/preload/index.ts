import { contextBridge, ipcRenderer } from 'electron'

const api = {
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfigAndReload: (config: any) => ipcRenderer.invoke('save-config-and-reload', config),
  saveConfigOnly: (config: any) => ipcRenderer.invoke('save-config-only', config),

  getIdentities: () => ipcRenderer.invoke('get-identities'),
  saveIdentities: (ids: any) => ipcRenderer.invoke('save-identities', ids),
  getActiveIdentity: () => ipcRenderer.invoke('get-active-identity'),
  setActiveIdentity: (id: string) => ipcRenderer.invoke('set-active-identity', id),
  renameIdentity: (id: string, name: string) => ipcRenderer.invoke('rename-identity', { id, name }),
  deleteIdentityFiles: (id: string) => ipcRenderer.invoke('delete-identity-files', id),

  walletAction: (action: string, payload?: any) => ipcRenderer.invoke('wallet-action', action, payload),
  getUplinkStatus: () => ipcRenderer.invoke('get-uplink-status'),
  retryEngine: () => ipcRenderer.invoke('retry-engine'),

  // Event Listeners (returning a cleanup function to remove the listener)
  onEngineStatus: (callback: any) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('engine-status', handler);
    return () => ipcRenderer.removeListener('engine-status', handler);
  },
  onCoreLog: (callback: any) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('core-log', handler);
    return () => ipcRenderer.removeListener('core-log', handler);
  },
  onWalletEvent: (callback: any) => {
    const handler = (_: any, data: any) => callback(data);
    ipcRenderer.on('wallet-event', handler);
    return () => ipcRenderer.removeListener('wallet-event', handler);
  },
  onVaultShutdown: (callback: any) => {
    ipcRenderer.once('vault-shutdown', callback); // Notice 'once' instead of 'on'
    return () => { };
  },
  proxyRequest: (payload: any) => ipcRenderer.invoke('proxy-request', payload),

  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  openPath: (targetPath: string) => ipcRenderer.invoke('open-path', targetPath),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  selectBackgroundImage: () => ipcRenderer.invoke('select-background-image'),

  confirmShutdown: () => ipcRenderer.send('confirm-shutdown')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
}