import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import http from 'http';
import httpProxy from 'http-proxy';
import { TorManager } from './tor-manager';
import { NodeManager } from './node-manager';

const Store = require('electron-store').default;
const store = new Store({ encryptionKey: 'kyc_rip_terminal_v1' });

const TOR_SOCKS_URL = 'socks5h://127.0.0.1:9050';
const torAgent = new SocksProxyAgent(TOR_SOCKS_URL);
const torManager = new TorManager();
const nodeManager = new NodeManager();

let isTorReady = false;

async function initTor(window?: BrowserWindow) {
  const useTor = !!store.get('use_tor');
  if (!useTor) return;
  const logToUI = (msg: string) => {
    window?.webContents.send('tor-status', msg);
    if (msg.includes('Bootstrapped 100%')) {
      isTorReady = true;
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

// --- Tactical Proxy Gate (V5: Network Isolated) ---
const proxy = httpProxy.createProxyServer({ changeOrigin: true, timeout: 30000, proxyTimeout: 60000 });

const localProxyServer = http.createServer((req, res) => {
  const useTor = !!store.get('use_tor');
  const isStagenet = !!store.get('is_stagenet');
  const configPrefix = isStagenet ? 'stagenet' : 'mainnet';
  
  const isAutoNode = store.get(`auto_node_${configPrefix}`) !== false;
  const customDaemon = store.get(`custom_daemon_${configPrefix}`);
  
  const baseTarget = (isAutoNode || !customDaemon) ? nodeManager.getBestNode() : customDaemon;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (useTor && !isTorReady) {
    res.writeHead(503);
    res.end(JSON.stringify({ error: 'TOR_BOOTSTRAPPING' }));
    return;
  }

  const attemptProxy = (nodeIndex: number) => {
    const currentTarget = nodeIndex === 0 ? baseTarget : nodeManager.getBestNode();
    if (req.url?.includes('.bin')) console.log(`[Gateway] Payload: ${req.url} -> ${currentTarget} (${configPrefix})`);

    proxy.web(req, res, { target: currentTarget, agent: useTor ? torAgent : undefined, buffer: undefined }, async (e: any) => {
      console.warn(`[Gateway] Lost: ${currentTarget} (${e.message})`);
      if (nodeIndex < 2 && isAutoNode) {
        await nodeManager.scout(isStagenet, useTor);
        attemptProxy(nodeIndex + 1);
      } else {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'LINK_EXHAUSTED' }));
      }
    });
  };
  attemptProxy(0);
});

localProxyServer.listen(18081, '0.0.0.0');

function createWindow(): void {
  const mainWindow = new BrowserWindow({ width: 1100, height: 720, show: false, backgroundColor: '#050505', titleBarStyle: 'hiddenInset', webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false, webSecurity: false } });
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

// IPC
ipcMain.handle('get-env', () => ({ API_URL: 'https://api.kyc.rip' }));
ipcMain.handle('get-config', (_, key) => store.get(key));
ipcMain.handle('set-config', (_, key, val) => { store.set(key, val); return true; });
ipcMain.handle('get-seed', () => store.get('master_seed'));
ipcMain.handle('save-seed', (_, s) => { store.set('master_seed', s); return true; });
ipcMain.handle('burn-identity', () => { store.delete('master_seed'); store.delete('last_sync_height'); return true; });
ipcMain.handle('get-uplink-status', () => ({ target: nodeManager.getBestNode(), useTor: !!store.get('use_tor'), isStagenet: !!store.get('is_stagenet') }));
ipcMain.handle('proxy-request', async (_, { url, method, data, headers, useTor }) => {
  try {
    const response = await axios({ url, method, data, headers, httpsAgent: (useTor && isTorReady) ? torAgent : undefined, httpAgent: (useTor && isTorReady) ? torAgent : undefined, timeout: 30000 });
    return { data: response.data, status: response.status };
  } catch (error: any) { return { error: error.message }; }
});
