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

async function initTor(window?: BrowserWindow) {
  const useTor = store.get('use_tor');
  if (!useTor) return;
  const logToUI = (msg: string) => window?.webContents.send('tor-status', msg);
  const success = await torManager.ensureTorExists(logToUI);
  if (success) {
    torManager.start(async (msg) => {
      logToUI(msg);
      // Once Tor is bootstrapped, trigger a re-scout for onion nodes
      if (msg.includes('Bootstrapped 100%')) {
        console.log('[NodeRadar] Tor Ready. Re-scouting onion nodes...');
        await nodeManager.scout(!!store.get('is_stagenet'), true);
      }
    });
  }
}

// --- Dynamic Node Scouting ---
async function startNodeRadar() {
  const isStagenet = !!store.get('is_stagenet');
  const useTor = !!store.get('use_tor');
  
  // Initial scout
  await nodeManager.scout(isStagenet, useTor);
  
  // Periodic re-scout every 10 minutes
  setInterval(() => {
    const freshIsStagenet = !!store.get('is_stagenet');
    const freshUseTor = !!store.get('use_tor');
    nodeManager.scout(freshIsStagenet, freshUseTor);
  }, 10 * 60 * 1000);
}

// --- Tactical Proxy Gate ---
const proxy = httpProxy.createProxyServer({ changeOrigin: true, proxyTimeout: 20000 });
const localProxyServer = http.createServer((req, res) => {
  const useTor = !!store.get('use_tor');
  let target = store.get('custom_daemon') || nodeManager.getBestNode();

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  proxy.web(req, res, { target, agent: useTor ? torAgent : undefined }, (e: any) => {
    console.error(`[Gateway] Fail: ${target} - ${e.message}`);
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'GATEWAY_FAIL', node: target }));
  });
});

localProxyServer.listen(18081, '0.0.0.0');

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100, height: 720,
    show: false,
    backgroundColor: '#050505',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webSecurity: false
    }
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    initTor(mainWindow);
  });

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('rip.kyc.terminal');
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window));
  startNodeRadar();
  createWindow();
});

app.on('will-quit', () => torManager.stop());
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// IPC Handlers
ipcMain.handle('get-env', () => ({ API_URL: 'https://api.kyc.rip' }));
ipcMain.handle('get-config', (_, key) => store.get(key));
ipcMain.handle('set-config', (_, key, val) => { store.set(key, val); return true; });
ipcMain.handle('get-seed', () => store.get('master_seed'));
ipcMain.handle('save-seed', (_, s) => { store.set('master_seed', s); return true; });
ipcMain.handle('burn-identity', () => { store.delete('master_seed'); return true; });
ipcMain.handle('get-best-node', () => nodeManager.getBestNode());

ipcMain.handle('proxy-request', async (_, { url, method, data, headers, useTor }) => {
  try {
    const response = await axios({
      url, method, data, headers,
      httpsAgent: useTor ? torAgent : undefined,
      httpAgent: useTor ? torAgent : undefined,
      timeout: 30000
    });
    return { data: response.data, status: response.status };
  } catch (error: any) {
    return { error: error.message };
  }
});
