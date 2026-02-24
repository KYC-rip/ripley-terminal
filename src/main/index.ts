// src/main/index.ts
import { app, BrowserWindow, ipcMain, net, session } from 'electron';
import { join } from 'path';
import { optimizer, electronApp } from '@electron-toolkit/utils';
import { DaemonManager } from './DaemonManager';
import { NodeManager } from './NodeManager';
import { WalletManager } from './WalletManager';
import { SyncWatcher } from './SyncWatcher';
import { AppConfig } from './types';
import { registerIdentityHandlers } from './handlers/IdentityHandler'; // ⬅️ Imported the rebuilt manager

function detectSystemProxy(): string {
  const proxyEnv = process.env.https_proxy || process.env.http_proxy || process.env.all_proxy ||
    process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (!proxyEnv) return '';
  try {
    const url = new URL(proxyEnv);
    if (url.hostname && url.port) return `${url.hostname}:${url.port}`;
    return proxyEnv;
  } catch (e) {
    return proxyEnv.replace(/^(http:\/\/|https:\/\/|socks5:\/\/|socks:\/\/)/i, '');
  }
}

const autoDetectedProxy = detectSystemProxy();
const Store = require('electron-store').default;
const store = new Store({
  clearInvalidConfig: true,
  defaults: {
    routingMode: 'tor',
    useSystemProxy: autoDetectedProxy !== "",
    systemProxyAddress: autoDetectedProxy || '127.0.0.1:7890',
    network: 'mainnet',
    customNodeAddress: '',
    show_scanlines: true,
    auto_lock_minutes: 10
  } as AppConfig
});

let mainWindow: BrowserWindow;
let daemonEngine: DaemonManager;
let nodeManager: NodeManager;
let watcher: SyncWatcher;

// 🟢 Global State Tracker (For UI polling)
const isStagenet = store.get("network") === 'stagenet';
let currentEngineState = { status: 'DISCONNECTED', node: '', useTor: false, error: '', isStagenet };
let isSafeToExit = false;

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('rip.kyc.terminal');

  session.defaultSession.setCertificateVerifyProc((_, callback) => {
    callback(0); // 0 stands for net::OK, direct unconditional release
  });

  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    backgroundColor: '#050505',
    titleBarStyle: 'hiddenInset',
    show: false, // Hide until ready
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  });

  mainWindow.on('ready-to-show', () => mainWindow.show());
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));

  // 🛡️ Graceful Shutdown Interceptor (Merged from old code)
  mainWindow.on('close', async (e) => {
    if (isSafeToExit) return;

    e.preventDefault();
    console.log('[Main] Shutdown sequence initiated. Saving wallet state...');

    // Instantly hide window so the app "feels" closed to the user while background saving completes
    mainWindow.hide();

    // Broadcast to UI to show a "Saving & Closing..." spinner (if they somehow unhide it)
    mainWindow.webContents.send('vault-shutdown');

    try {
      if (watcher) watcher.stop();

      // Give the Wallet RPC a maximum of 8 seconds to save its block state.
      // If it hangs longer than that, kill the engine anyway, so the app actually exits.
      await Promise.race([
        WalletManager.closeWallet(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Wallet save timeout')), 8000))
      ]);

      if (daemonEngine) daemonEngine.killAll();
    } catch (err) {
      console.error('[Main] Error during shutdown:', err);
    } finally {
      isSafeToExit = true;
      app.quit();
    }
  });

  daemonEngine = new DaemonManager();
  nodeManager = new NodeManager();
  watcher = new SyncWatcher(mainWindow);

  daemonEngine.setLogListener((source, level, message) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('core-log', { source, level, message });
    }
  });


  // 🔌 Register the Identity/Vault Handlers
  registerIdentityHandlers(store);
  // ---------------------------------------------------------
  // 🔌 IPC Channels
  // ---------------------------------------------------------
  ipcMain.handle('get-uplink-status', () => currentEngineState);
  ipcMain.handle('retry-engine', () => reloadEngine(true));

  ipcMain.handle('get-config', () => store.store);

  ipcMain.handle('save-config-and-reload', async (_, newConfig: AppConfig) => {
    store.set(newConfig);
    try {
      await reloadEngine();
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('save-config-only', (_, newConfig: AppConfig) => {
    store.set(newConfig);
    console.log('[Config] Logical settings updated (Scanlines/LockTime).');
    return { success: true };
  });

  ipcMain.handle('get-app-info', () => {
    return {
      version: app.getVersion(),
      appDataPath: app.getPath('userData'),
      walletsPath: join(app.getPath('userData'), 'wallets'),
      platform: process.platform
    };
  });

  ipcMain.handle('open-path', async (_, targetPath: string) => {
    // shell.openPath returns a string error message if it fails, or empty string if it succeeds
    const error = await require('electron').shell.openPath(targetPath);
    return { success: !error, error };
  });

  ipcMain.handle('check-for-updates', async () => {
    try {
      const response = await net.fetch('https://api.github.com/repos/KYC-rip/ghost-terminal/releases/latest');
      if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
      const release = await response.json() as any;
      const latestVersion = release.tag_name.replace(/^v/, '');
      const currentVersion = app.getVersion();
      const hasUpdate = latestVersion !== currentVersion;
      return {
        success: true,
        hasUpdate,
        latestVersion,
        releaseUrl: release.html_url,
        body: release.body,
        publishedAt: release.published_at
      };
    } catch (e: any) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('proxy-request', async (_, payload: { method: string; params: any }) => {
    try {
      const response = await net.fetch('http://127.0.0.1:18082/json_rpc', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '0',
          method: payload.method,
          params: payload.params
        })
      });

      const data = await response.json();

      if (data.error) {
        return { success: false, error: data.error.message };
      }

      return { success: true, result: data.result };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('wallet-action', async (_, action: string, payload: any) => {
    try {
      if ((action === 'create' || action === 'open') && !payload?.name) {
        throw new Error("Missing wallet filename");
      }

      switch (action) {
        case 'create':
          if (payload.seed) {
            // Restore from mnemonic seed
            await WalletManager.restoreWallet(
              payload.name,
              payload.pwd,
              payload.seed,
              payload.height || 0,
              payload.language || 'English'
            );
            watcher.start();
            return { success: true };
          } else {
            // Create fresh wallet, then retrieve the generated seed
            await WalletManager.createWallet(payload.name, payload.pwd);
            const seed = await WalletManager.getMnemonic();
            watcher.start();
            return { success: true, seed, address: '' };
          }
        case 'open':
          await WalletManager.openWallet(payload.name, payload.pwd);
          watcher.start();
          return { success: true };
        case 'close':
          watcher.stop();
          await WalletManager.closeWallet();
          return { success: true };
        case 'mnemonic':
          const seed = await WalletManager.getMnemonic();
          return { success: true, seed };
        default:
          return { success: false, error: 'Unknown action' };
      }
    } catch (error: any) {
      console.error('[Main] Wallet action error:', error);
      return { success: false, error: error.message };
    }
  });

  if (app.isPackaged) {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  } else {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] || 'http://localhost:5173');
  }


  // 🚀 Start the engine
  reloadEngine();
});

async function applyGlobalNetworkRouting(config: AppConfig, torSocksPort: number) {
  let activeProxyUrl = '';
  const useTor = config.routingMode === 'tor' ||
    (!!config.customNodeAddress && config.customNodeAddress.includes('.onion'));

  if (useTor) {
    activeProxyUrl = `socks5://127.0.0.1:${torSocksPort}`;
  } else if (config.useSystemProxy && config.systemProxyAddress) {
    activeProxyUrl = config.systemProxyAddress.includes('://')
      ? config.systemProxyAddress
      : `socks5://${config.systemProxyAddress}`;
  }

  if (activeProxyUrl) {
    await session.defaultSession.setProxy({ proxyRules: activeProxyUrl, proxyBypassRules: '127.0.0.1, localhost' });
    console.log(`[Network] 🛡️ Traffic sealed. Route: ${activeProxyUrl}`);
  } else {
    await session.defaultSession.setProxy({ proxyRules: 'direct://', proxyBypassRules: '127.0.0.1, localhost' });
    console.log(`[Network] ⚠️ Traffic on Clearnet (Direct)`);
  }
}

let lastPhysicalConfig = {
  routingMode: '',
  network: '',
  customNodeAddress: ''
};
async function reloadEngine(forceRestart = false) {
  const config = store.store;

  // 🔍 1. Check if physical parameters have changed
  const physicalChanged =
    config.routingMode !== lastPhysicalConfig.routingMode ||
    config.network !== lastPhysicalConfig.network ||
    config.customNodeAddress !== lastPhysicalConfig.customNodeAddress;

  // 🛡️ If status is ONLINE, physical parameters haven't changed, and it's not a forced restart, skip reload.
  if (currentEngineState.status === 'ONLINE' && !physicalChanged && !forceRestart) {
    console.log('[Engine] Configuration updated, but physical uplink remains unchanged. Skipping reload.');
    return;
  }

  // 🚀 Only physical changes reach this point
  console.log('[Engine] Physical reconfiguration triggered...');

  currentEngineState.status = 'CONNECTING';
  mainWindow?.webContents.send('engine-status', currentEngineState);

  watcher.stop();
  daemonEngine.killAll();

  try {
    const useTor = config.routingMode === 'tor' ||
      (!!config.customNodeAddress && config.customNodeAddress.includes('.onion'));

    if (useTor) {
      const torFrontProxy = (config.useSystemProxy && config.systemProxyAddress)
        ? config.systemProxyAddress : undefined;
      await daemonEngine.startTor(torFrontProxy);
    }

    await applyGlobalNetworkRouting(config, daemonEngine.torSocksPort);

    await nodeManager.fetchRemoteNodes();

    let targetNode = '';
    if (config.customNodeAddress) {
      targetNode = config.customNodeAddress;
      NodeManager.activeNodeStr = targetNode;
      // We must manually ping the custom node to fetch daemonHeight for UI progress syncing
      try {
        await nodeManager.pingNode(targetNode);
      } catch (e) {
        console.warn('[Engine] Custom node ping failed, sync progress percentages may be unavailable.');
      }
    } else {
      targetNode = await nodeManager.findFastestNode(config.network, useTor ? 'tor' : 'clearnet');
    }

    await daemonEngine.startMoneroRpc(targetNode, useTor, config.useSystemProxy, config.systemProxyAddress);

    // ✅ Update successful, syncing snapshot
    lastPhysicalConfig = {
      routingMode: config.routingMode,
      network: config.network,
      customNodeAddress: config.customNodeAddress
    };

    currentEngineState = { status: 'ONLINE', node: targetNode, useTor, error: '', isStagenet: config.network === 'stagenet' };
    mainWindow?.webContents.send('engine-status', currentEngineState);

  } catch (error: any) {
    console.error('[Engine] Start failed:', error);
    currentEngineState = { status: 'ERROR', node: '', useTor: false, error: error.message, isStagenet: config.network === 'stagenet' };
    mainWindow?.webContents.send('engine-status', currentEngineState);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});