import { app, shell, BrowserWindow, ipcMain } from 'electron';
import { join } from 'path';
import fs from 'fs';
import http from 'http';
import httpProxy from 'http-proxy';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { SocksProxyAgent } from 'socks-proxy-agent';
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

const proxy = httpProxy.createProxyServer({ changeOrigin: true, proxyTimeout: 60000 });
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
  if (useTor && !isTorReady) { res.writeHead(503); res.end(JSON.stringify({ error: 'TOR_BOOTSTRAPPING' })); return; }
  const attemptProxy = (nodeIndex: number) => {
    const currentTarget = nodeIndex === 0 ? baseTarget : nodeManager.getBestNode();
    proxy.web(req, res, { target: currentTarget, agent: useTor ? torAgent : undefined }, async (e: any) => {
      if (nodeIndex < 2 && isAutoNode) { await nodeManager.scout(isStagenet, useTor); attemptProxy(nodeIndex + 1); } 
      else { res.writeHead(502); res.end(JSON.stringify({ error: 'LINK_EXHAUSTED' })); }
    });
  };
  attemptProxy(0);
});
localProxyServer.listen(18082, '0.0.0.0');

// --- IPC Handlers ---
ipcMain.handle('get-uplink-status', () => ({ target: nodeManager.getBestNode(), useTor: !!store.get('use_tor'), isTorReady, isStagenet: !!store.get('is_stagenet') }));
ipcMain.handle('get-config', (_, key) => store.get(key));
ipcMain.handle('set-config', (_, key, val) => { store.set(key, val); return true; });
ipcMain.handle('get-identities', () => {
  const ids = store.get('identities');
  if (!ids) {
    const defaultId = [{ id: 'primary', name: 'DEFAULT_VAULT', created: Date.now() }];
    store.set('identities', defaultId);
    return defaultId;
  }
  return ids;
});
ipcMain.handle('save-identities', (_, ids) => { store.set('identities', ids); return true; });
ipcMain.handle('get-active-identity', () => store.get('active_identity_id') || 'primary');
ipcMain.handle('set-active-identity', (_, id) => { store.set('active_identity_id', id); return true; });

// --- Secure Binary File Management (Base64 Tunneling) ---
ipcMain.handle('read-wallet-file', async (_, filename) => {
  try {
    const p = join(app.getPath('userData'), 'wallets', filename);
    if (!fs.existsSync(p)) return null;
    // Return as Base64 string to ensure 100% transfer integrity
    return fs.readFileSync(p, { encoding: 'base64' });
  } catch (e) { return null; }
});

ipcMain.handle('write-wallet-file', async (_, { filename, data }) => {
  try {
    const dir = join(app.getPath('userData'), 'wallets');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    
    if (!data) throw new Error("DATA_IS_UNDEFINED");
    
    // Write from Base64 string back to binary disk file
    fs.writeFileSync(join(dir, filename), Buffer.from(data, 'base64'));
    return true;
  } catch (e) {
    console.error(`[Main] Write failed for ${filename}:`, e);
    return false;
  }
});

// --- Proxy Request ---
async function tacticalFetch(url: string, options: any, useTor: boolean) {
  if (useTor) {
    if (!isTorReady) throw new Error('TOR_NOT_READY');
    const https = require('https');
    const { URL } = require('url');
    const parsedUrl = new URL(url);
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: options.headers,
        agent: torAgent
      }, (res: any) => {
        let body = '';
        res.on('data', (chunk: any) => body += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, json: async () => JSON.parse(body) }); } 
          catch (e) { reject(new Error('INVALID_JSON_RESPONSE')); }
        });
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }
  return fetch(url, options);
}

ipcMain.handle('proxy-request', async (_, { url, method, data, headers = {} }) => {
  try {
    const useTor = !!store.get('use_tor');
    if (useTor && !isTorReady) return { error: 'TOR_BOOTSTRAPPING' };
    const fetchOptions: any = { method, headers: { 'User-Agent': 'curl/7.64.1', 'Accept': 'application/json', ...headers } };
    if (data) fetchOptions.body = typeof data === 'string' ? data : JSON.stringify(data);
    const response: any = await tacticalFetch(url, fetchOptions, useTor);
    const resultData = await response.json();
    return { data: resultData, status: response.status };
  } catch (error: any) { return { error: error.message }; }
});

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
