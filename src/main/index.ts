import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import http from 'http';
import httpProxy from 'http-proxy';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { TorManager } from './tor-manager';
import { NodeManager } from './node-manager';

// Handlers
import { registerIdentityHandlers } from './handlers/IdentityHandler';
import { registerFileHandlers } from './handlers/FileHandler';
import { registerProxyHandlers } from './handlers/ProxyHandler';

const Store = require('electron-store').default;
const store = new Store({ encryptionKey: 'kyc_rip_terminal_v1' });

const torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050');
const torManager = new TorManager();
const nodeManager = new NodeManager();

const state = { isTorReady: false };
const torReadyRef = { get current() { return state.isTorReady; }, set current(v) { state.isTorReady = v; } };

async function initTor(window?: BrowserWindow) {
  const useTor = store.get('use_tor') !== false; // 🛡️ Default to TRUE if undefined
  if (!useTor) return;
  const logToUI = (msg: string) => {
    window?.webContents.send('tor-status', msg);
    if (msg.includes('Bootstrapped 100%')) {
      torReadyRef.current = true;
      nodeManager.scout(!!store.get('is_stagenet'), true);
    }
  };
  const exists = await torManager.ensureTorExists(logToUI);
  if (exists) torManager.start(logToUI);
}

async function startNodeRadar() {
  const isStagenet = !!store.get('is_stagenet');
  const useTor = !!store.get('use_tor');
  await nodeManager.scout(isStagenet, useTor);
  setInterval(() => nodeManager.scout(!!store.get('is_stagenet'), !!store.get('use_tor')), 10 * 60 * 1000);
}

const proxy = httpProxy.createProxyServer({ 
  changeOrigin: true, 
  proxyTimeout: 120000, // 🛡️ Extend to 120s for Tor resilience
  timeout: 120000 
});
const localProxyServer = http.createServer((req, res) => {
  const useTor = !!store.get('use_tor');
  const isStagenet = !!store.get('is_stagenet');
  const configPrefix = isStagenet ? 'stagenet' : 'mainnet';
  const isAutoNode = store.get(`auto_node_${configPrefix}`) !== false;
  const customDaemon = store.get(`custom_daemon_${configPrefix}`);
  const baseTarget = (isAutoNode || !customDaemon) ? nodeManager.getBestNode(useTor) : customDaemon;
  
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  
  if (useTor && !torReadyRef.current) { 
    res.writeHead(503); 
    res.end(JSON.stringify({ error: 'TOR_BOOTSTRAPPING' })); 
    return; 
  }

  const attemptProxy = (nodeIndex: number) => {
    // 🛡️ RESPECT USER CHOICE: If auto-node is off, NEVER switch to NodeManager nodes.
    const currentTarget = (nodeIndex === 0 || !isAutoNode) ? baseTarget : nodeManager.getBestNode(useTor);
    
    proxy.web(req, res, { target: currentTarget, agent: useTor ? torAgent : undefined }, async (e: any) => {
      // 🔄 RETRY STRATEGY: 
      // 1. If AutoNode is ON: Switch nodes after each failure.
      // 2. If AutoNode is OFF: Retry on the same custom node (to handle Tor/Network flickers).
      if (nodeIndex < 5) { 
        console.warn(`[Proxy] Request failed for ${currentTarget}. Retry ${nodeIndex + 1}/5...`);
        
        // Wait 1s before retry to let circuit recover
        await new Promise(r => setTimeout(r, 1000));
        
        // Only scout/refresh if we are in auto-node mode
        if (isAutoNode && nodeIndex % 2 === 0) await nodeManager.scout(isStagenet, useTor); 
        
        attemptProxy(nodeIndex + 1); 
      } 
      else { 
        const errorMsg = isAutoNode ? 'LINK_EXHAUSTED' : 'NODE_UNREACHABLE';
        console.error(`[Proxy] ${errorMsg}: Failed after maximum retries for ${currentTarget}`);
        res.writeHead(502); 
        res.end(JSON.stringify({ error: errorMsg })); 
      }
    });
  };
  attemptProxy(0);
});
localProxyServer.listen(18082, '0.0.0.0');

// --- Register All IPC Handlers ---
ipcMain.handle('get-uplink-status', () => {
  const useTor = !!store.get('use_tor');
  return { 
    target: nodeManager.getBestNode(useTor), 
    useTor, 
    isTorReady: torReadyRef.current, 
    isStagenet: !!store.get('is_stagenet') 
  };
});
ipcMain.handle('get-config', (_, key) => store.get(key));
ipcMain.handle('set-config', (_, key, val) => { store.set(key, val); return true; });

// Dispatch to Modules
registerIdentityHandlers(store);
registerFileHandlers();
registerProxyHandlers(store, torAgent, torReadyRef);

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100, height: 720, show: false, backgroundColor: '#050505', titleBarStyle: 'hiddenInset',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, webSecurity: false }
  });
  mainWindow.on('ready-to-show', () => mainWindow.show());
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('rip.kyc.terminal');
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));
  startNodeRadar().then(() => initTor());
  createWindow();
});
app.on('will-quit', () => torManager.stop());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
