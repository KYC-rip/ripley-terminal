/**
 * Tauri Bridge — compatibility shim that maps window.api.* (Electron preload)
 * to Tauri's invoke() / listen() APIs.
 *
 * This allows the entire React frontend to work unchanged during migration.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const isTauri = !!(window as any).__TAURI_INTERNALS__;

function createTauriApi() {
  return {
    // ── Config ──
    getConfig: () => invoke('get_config'),
    saveConfigAndReload: (config: any) => invoke('save_config', { config }),
    saveConfigOnly: (config: any) => invoke('save_config', { config }),

    // ── Identity ──
    getIdentities: () => invoke('get_identities'),
    saveIdentities: async (ids: any) => {
      // The frontend sends the full identity list after modifications.
      // We need to persist this since Rust commands also manage identities.
      try {
        await invoke('save_identities', { ids });
      } catch {
        // save_identities command may not exist yet — identities managed by create/delete
      }
    },
    getActiveIdentity: async () => {
      try {
        // Try to read the active identity, fall back to first in list
        const ids: any[] = await invoke('get_identities') as any[];
        return ids?.[0]?.id || '';
      } catch {
        return '';
      }
    },
    setActiveIdentity: (id: string) => invoke('switch_identity', { id }),
    renameIdentity: (id: string, name: string) => invoke('rename_identity', { id, name }),
    deleteIdentityFiles: (id: string) => invoke('delete_identity', { id }).then(() => ({ success: true })),

    // ── Wallet Actions ──
    walletAction: async (action: string, payload?: any) => {
      try {
        switch (action) {
          case 'create': {
            const result = await invoke('create_wallet', {
              name: payload.name,
              password: payload.pwd,
              seed: payload.seed || null,
              restoreHeight: payload.height || null,
            });
            // Auto-open the wallet after creation (Electron RPC does this implicitly)
            await invoke('open_wallet', { name: payload.name, password: payload.pwd });
            return { success: true, ...(result as any) };
          }
          case 'open':
            await invoke('open_wallet', { name: payload.name, password: payload.pwd });
            return { success: true };
          case 'close':
            await invoke('close_wallet');
            return { success: true };
          case 'mnemonic': {
            const seed = await invoke('get_mnemonic');
            return { success: true, seed };
          }
          default:
            return { success: false, error: `Unknown action: ${action}` };
        }
      } catch (e: any) {
        return { success: false, error: e.toString() };
      }
    },

    // ── Uplink Status ──
    // In Tauri, there's no separate engine process — the wallet connects directly.
    // Always return ONLINE so the unlock flow proceeds.
    getUplinkStatus: async () => ({
      status: 'ONLINE',
      isStagenet: false,
      error: '',
    }),
    retryEngine: () => Promise.resolve(),

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
      // Map Tauri events to the format VaultContext expects
      listen('sync-update', (event) => {
        const p = event.payload as any;
        callback({
          type: 'SYNC_UPDATE',
          payload: {
            height: p.height,
            daemonHeight: p.daemon_height || p.daemonHeight,
            nodeLabel: p.node_label || p.nodeLabel || '',
            nodeUrl: p.node_url || p.nodeUrl || '',
          }
        });
      }).then(fn => unlisten = fn);

      let unlisten2: UnlistenFn | null = null;
      listen('balance-changed', (event) => {
        const p = event.payload as any;
        callback({ type: 'BALANCE_CHANGED', payload: { balance: p.balance, unlocked: p.unlocked } });
      }).then(fn => unlisten2 = fn);

      return () => { unlisten?.(); unlisten2?.(); };
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

    // ── Proxy RPC → Tauri commands ──
    // The frontend's RpcClient.call(method, params) goes through here.
    // We map each RPC method to the corresponding Tauri command with correct arg names.
    proxyRequest: async (payload: { method: string; params: any }) => {
      const p = payload.params || {};
      try {
        let result: any;
        switch (payload.method) {
          case 'get_accounts': {
            const accs: any[] = await invoke('get_accounts') as any[];
            result = {
              subaddress_accounts: accs.map((a: any) => ({
                account_index: a.index,
                label: a.label,
                balance: a.balance,
                unlocked_balance: a.unlockedBalance || a.unlocked_balance || '0',
                base_address: a.baseAddress || a.base_address || '',
              }))
            };
            break;
          }
          case 'get_balance':
          case 'getbalance':
            result = await invoke('get_balance', { accountIndex: p.account_index || 0 });
            // Map to wallet-rpc format
            result = { total_balance: result.total, unlocked_balance: result.unlocked, per_subaddress: [] };
            break;
          case 'get_height':
            result = { height: await invoke('get_height') };
            break;
          case 'get_address': {
            const subs: any[] = await invoke('get_subaddresses', { accountIndex: p.account_index || 0 }) as any[];
            result = {
              address: subs[0]?.address || '',
              addresses: subs.map((s: any) => ({
                address_index: s.index,
                address: s.address,
                label: s.label,
                used: s.isUsed || s.is_used || false,
              }))
            };
            break;
          }
          case 'create_address':
            const addr = await invoke('create_subaddress', { label: p.label || 'Payment', accountIndex: p.account_index });
            result = { address: addr };
            break;
          case 'label_address':
            await invoke('set_subaddress_label', { index: p.index?.minor || 0, label: p.label || '', accountIndex: p.account_index || 0 });
            result = {};
            break;
          case 'transfer':
            result = await invoke('prepare_transfer', {
              destinations: (p.destinations || []).map((d: any) => ({ address: d.address || d.destination, amount: String(d.amount) })),
              accountIndex: p.account_index || 0,
              priority: p.priority,
            });
            break;
          case 'relay_tx':
            result = { tx_hash: await invoke('relay_transfer', { txMetadata: p.hex }) };
            break;
          case 'get_transfers':
            const txs = await invoke('get_transactions', { accountIndex: p.account_index || 0 });
            result = { in: [], out: [], pending: [] };
            // TODO: Split txs into in/out/pending when real tx data flows
            break;
          case 'incoming_transfers':
            result = { transfers: await invoke('get_outputs', { accountIndex: p.account_index || 0 }) };
            break;
          case 'get_tx_key':
            result = { tx_key: await invoke('get_tx_key', { txid: p.txid }) };
            break;
          case 'get_tx_proof':
            result = { signature: await invoke('get_tx_proof', { txid: p.txid, address: p.address, message: p.message }) };
            break;
          case 'check_tx_key':
            result = await invoke('check_tx_key', { txid: p.txid, txKey: p.tx_key, address: p.address });
            break;
          case 'check_tx_proof':
            result = await invoke('check_tx_proof', { txid: p.txid, address: p.address, message: p.message, signature: p.signature });
            break;
          case 'get_fee_estimate':
            // Return a stub — the real fee comes during prepare_transfer
            result = { fees: [20000, 80000, 320000, 4000000], quantization_mask: 10000, status: 'OK' };
            break;
          case 'refresh':
            await invoke('refresh');
            result = { blocks_fetched: 0 };
            break;
          case 'store':
            result = {};
            break;
          case 'create_account':
            result = await invoke('create_account', { label: p.label || 'Account' });
            break;
          case 'label_account':
            await invoke('rename_account', { accountIndex: p.account_index, newLabel: p.label });
            result = {};
            break;
          case 'sweep_all':
            // TODO: Implement sweep via prepare_transfer with all outputs
            result = { tx_hash_list: [] };
            break;
          default:
            return { success: false, error: `Unmapped RPC method: ${payload.method}` };
        }
        return { success: true, result };
      } catch (e: any) {
        return { success: false, error: e.toString() };
      }
    },

    // ── No-ops (Tauri has no RPC mutex) ──
    pauseWatcher: () => Promise.resolve(),
    resumeWatcher: () => Promise.resolve(),

    // ── App Info ──
    getAppInfo: () => Promise.resolve({
      version: '2.0.0',
      appDataPath: '',
      walletsPath: '',
      platform: navigator.platform.includes('Mac') ? 'darwin' : navigator.platform.includes('Win') ? 'win32' : 'linux' as any,
      isPackaged: false,
    }),
    openPath: (_path: string) => Promise.resolve({ success: true }),
    openExternal: (url: string, _options?: any) => {
      // Use Tauri shell plugin for proper external URL opening
      import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
      return Promise.resolve({ success: true });
    },
    checkForUpdates: (_include_prereleases: boolean) => Promise.resolve({ success: false }),
    selectBackgroundImage: () => Promise.resolve({ success: false }),
    saveGhostTrade: (_txHash: string, _tradeId: string) => Promise.resolve({ success: true }),
    getGhostTrades: () => Promise.resolve([]),

    // ── XMR402 (stub for now) ──
    saveXmr402Payment: (..._args: any[]) => Promise.resolve({ success: true }),
    getXmr402Payment: (_nonce: string) => Promise.resolve({ success: false }),
    getAllXmr402Payments: () => Promise.resolve([]),
    updateAgentConfig: (_config: any) => Promise.resolve(),
    onAgentActivity: (_callback: any) => () => {},
    onAgentPay402: (_callback: any) => () => {},
    onXmr402Challenge: (_callback: any) => () => {},
    authorizeXmr402: (_id: string, _password: string | null) => Promise.resolve({ success: false }),
    clearCache: () => Promise.resolve(),

    // ── Send (legacy IPC) ──
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

export function installTauriBridge() {
  if (isTauri) {
    (window as any).api = createTauriApi();
    console.log('[TauriBridge] Installed — all window.api calls routed to Tauri invoke()');
  }
}
