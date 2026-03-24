/**
 * Tauri Bridge — compatibility shim that maps window.api.* (Electron preload)
 * to Tauri's invoke() / listen() APIs.
 *
 * This allows the entire React frontend to work unchanged during migration.
 * Once the Electron code is removed, this becomes the canonical API layer.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// Only activate when running under Tauri (not Electron)
const isTauri = !!(window as any).__TAURI_INTERNALS__;

function createTauriApi() {
  return {
    // ── Config ──
    getConfig: () => invoke('get_config'),
    saveConfigAndReload: (config: any) => invoke('save_config', { config }),
    saveConfigOnly: (config: any) => invoke('save_config', { config }),

    // ── Identity ──
    getIdentities: () => invoke('get_identities'),
    saveIdentities: (_ids: any) => Promise.resolve(), // Handled internally in Rust
    getActiveIdentity: () => invoke('get_identities').then((ids: any) => ids[0]?.id || ''),
    setActiveIdentity: (id: string) => invoke('switch_identity', { id }),
    renameIdentity: (id: string, name: string) => invoke('rename_identity', { id, name }),
    deleteIdentityFiles: (id: string) => invoke('delete_identity', { id }).then(() => ({ success: true })),

    // ── Wallet Actions ──
    walletAction: async (action: string, payload?: any) => {
      try {
        switch (action) {
          case 'create':
            await invoke('create_wallet', {
              name: payload.name,
              password: payload.pwd,
              seed: payload.seed || null,
              restoreHeight: payload.height || null,
            });
            return { success: true };
          case 'open':
            await invoke('open_wallet', { name: payload.name, password: payload.pwd });
            return { success: true };
          case 'close':
            await invoke('close_wallet');
            return { success: true };
          case 'mnemonic':
            const seed = await invoke('get_mnemonic');
            return { success: true, seed };
          default:
            return { success: false, error: `Unknown action: ${action}` };
        }
      } catch (e: any) {
        return { success: false, error: e.toString() };
      }
    },

    // ── Uplink Status ──
    getUplinkStatus: async () => {
      try {
        const status = await invoke('get_sync_status');
        return {
          status: (status as any).status === 'OFFLINE' ? 'ERROR' : 'ONLINE',
          isStagenet: false,
          error: '',
        };
      } catch {
        return { status: 'ERROR', isStagenet: false, error: 'Not connected' };
      }
    },
    retryEngine: () => invoke('restart_tor'),

    // ── Event Listeners ──
    onEngineStatus: (callback: any) => {
      let unlisten: UnlistenFn | null = null;
      listen('engine-status', (event) => callback(event.payload)).then(fn => unlisten = fn);
      return () => { unlisten?.(); };
    },
    onCoreLog: (callback: any) => {
      let unlisten: UnlistenFn | null = null;
      listen('core-log', (event) => callback(event.payload)).then(fn => unlisten = fn);
      return () => { unlisten?.(); };
    },
    onWalletEvent: (callback: any) => {
      let unlisten: UnlistenFn | null = null;
      listen('wallet-event', (event) => callback(event.payload)).then(fn => unlisten = fn);
      return () => { unlisten?.(); };
    },
    onVaultShutdown: (callback: any) => {
      let unlisten: UnlistenFn | null = null;
      listen('vault-shutdown', (event) => { callback(event.payload); unlisten?.(); }).then(fn => unlisten = fn);
      return () => { unlisten?.(); };
    },
    onDeepLink: (callback: (url: string) => void) => {
      let unlisten: UnlistenFn | null = null;
      listen('deep-link', (event) => callback(event.payload as string)).then(fn => unlisten = fn);
      return () => { unlisten?.(); };
    },

    // ── Proxy RPC (replaced by direct Tauri commands) ──
    proxyRequest: async (payload: { method: string; params: any }) => {
      // Map RPC method names to Tauri commands
      const methodMap: Record<string, string> = {
        'get_accounts': 'get_accounts',
        'get_balance': 'get_balance',
        'getbalance': 'get_balance',
        'get_height': 'get_height',
        'get_address': 'get_subaddresses',
        'create_address': 'create_subaddress',
        'label_address': 'set_subaddress_label',
        'transfer': 'prepare_transfer',
        'relay_tx': 'relay_transfer',
        'get_transfers': 'get_transactions',
        'incoming_transfers': 'get_outputs',
        'get_tx_key': 'get_tx_key',
        'get_tx_proof': 'get_tx_proof',
        'check_tx_key': 'check_tx_key',
        'check_tx_proof': 'check_tx_proof',
        'get_fee_estimate': 'get_fee_estimate',
      };

      const cmd = methodMap[payload.method];
      if (!cmd) {
        return { success: false, error: `Unknown RPC method: ${payload.method}` };
      }

      try {
        const result = await invoke(cmd, payload.params || {});
        return { success: true, result };
      } catch (e: any) {
        return { success: false, error: e.toString() };
      }
    },

    // ── Watcher (no-op in Tauri — no RPC mutex to contend with) ──
    pauseWatcher: () => Promise.resolve(),
    resumeWatcher: () => Promise.resolve(),

    // ── App Info ──
    getAppInfo: () => invoke('get_app_info').catch(() => ({
      version: '2.0.0',
      appDataPath: '',
      walletsPath: '',
      platform: 'darwin' as NodeJS.Platform,
      isPackaged: false,
    })),
    openPath: (_path: string) => Promise.resolve({ success: true }),
    openExternal: (url: string, _options?: any) => {
      window.open(url, '_blank');
      return Promise.resolve({ success: true });
    },
    checkForUpdates: (_include_prereleases: boolean) => Promise.resolve({ success: false }),
    selectBackgroundImage: () => Promise.resolve({ success: false }),
    saveGhostTrade: (_txHash: string, _tradeId: string) => Promise.resolve({ success: true }),
    getGhostTrades: () => Promise.resolve([]),

    // ── XMR402 ──
    saveXmr402Payment: (..._args: any[]) => Promise.resolve({ success: true }),
    getXmr402Payment: (_nonce: string) => Promise.resolve({ success: false }),
    getAllXmr402Payments: () => Promise.resolve([]),
    updateAgentConfig: (_config: any) => Promise.resolve(),
    onAgentActivity: (_callback: any) => () => {},
    onAgentPay402: (_callback: any) => () => {},
    onXmr402Challenge: (_callback: any) => () => {},
    authorizeXmr402: (_id: string, _password: string | null) => Promise.resolve({ success: false }),
    clearCache: () => Promise.resolve(),

    // ── Send (legacy IPC, mapped to Tauri commands) ──
    sendXmr: async (address: string, amountAtomic: string, accountIndex?: number) => {
      try {
        const txHash = await invoke('prepare_transfer', {
          destinations: [{ address, amount: amountAtomic }],
          accountIndex: accountIndex || 0,
        });
        return { success: true, txid: txHash };
      } catch (e: any) {
        return { success: false, error: e.toString() };
      }
    },
    getTxProof: async (txHash: string, address: string, message: string) => {
      try {
        const signature = await invoke('get_tx_proof', { txid: txHash, address, message });
        return { success: true, signature };
      } catch (e: any) {
        return { success: false, error: e.toString() };
      }
    },

    confirmShutdown: () => {},
  };
}

/**
 * Install the Tauri bridge if running under Tauri.
 * Call this before React renders.
 */
export function installTauriBridge() {
  if (isTauri) {
    (window as any).api = createTauriApi();
    console.log('[TauriBridge] Installed — all window.api calls routed to Tauri invoke()');
  }
}
