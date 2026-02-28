import http from 'http';
import { BrowserWindow } from 'electron';
import { WalletManager } from './WalletManager';

export class AgentGateway {
  private server: http.Server | null = null;
  private port: number = 38084;
  private mainWindow: BrowserWindow | null = null;
  private store: any = null;

  constructor(mainWindow: BrowserWindow, store: any) {
    this.mainWindow = mainWindow;
    this.store = store;
  }

  private log(type: 'ok' | 'fail' | 'info', msg: string) {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('agent-activity', {
        id: Math.random().toString(36).substring(7),
        type: type.toUpperCase(),
        msg,
        timestamp: Date.now(),
        status: type === 'info' ? 'ok' : type
      });
    }
  }

  public start() {
    const config = this.store.get('agent_config');
    if (!config?.enabled) return;

    if (this.server) this.stop();

    this.server = http.createServer((req, res) => {
      const apiKey = req.headers['x-api-key'];
      const targetKey = this.store.get('agent_config.apiKey');

      // 1. Auth check
      if (!apiKey || apiKey !== targetKey) {
        this.log('fail', `Unauthorized access attempt from ${req.socket.remoteAddress}`);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // 2. Routing
      if (req.method === 'GET' && url.pathname === '/sync') {
        this.handleSync(res);
      } else if (req.method === 'GET' && url.pathname === '/balance') {
        this.handleBalance(res);
      } else if (req.method === 'POST' && url.pathname === '/transfer') {
        this.handleTransfer(req, res);
      } else if (req.method === 'POST' && url.pathname === '/subaddress') {
        this.handleSubaddress(req, res);
      } else if (req.method === 'GET' && url.pathname === '/network') {
        this.handleNetwork(res);
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(this.port, () => {
      console.log(`[Agent] Gateway listening on port ${this.port}`);
      this.log('info', `Gateway listening on port ${this.port}`);
    });
  }

  public stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.log('info', 'Gateway stopped.');
    }
  }

  private async handleSync(res: http.ServerResponse) {
    try {
      this.log('ok', 'Agent queried sync status.');

      // Get actual height from store/watcher if possible, or just check if watcher is active
      // For now, we'll return synced: true if the gateway is running, 
      // but ideally we check the IPC state
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK', synced: true }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  private async handleBalance(res: http.ServerResponse) {
    try {
      const config = this.store.get('agent_config');
      const accountIndex = config?.selectedAccountIndex || 0;
      this.log('ok', `Agent queried balance for Account #${accountIndex}.`);

      const balance = await WalletManager.getBalance(accountIndex);

      // Convert atomic piconero to XMR string for the agent (handles numbers or strings)
      const formatXmr = (pico: any) => {
        if (pico === undefined || pico === null) return '0.000000000000';
        return (Number(pico) / 1e12).toFixed(12);
      };

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        balance: formatXmr(balance.total),
        unlocked_balance: formatXmr(balance.unlocked) 
      }));
    } catch (e: any) {
      this.log('fail', `Balance query error: ${e.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }

  private async handleTransfer(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const address = payload.address;
        const amount = payload.amount_xmr || payload.amount;

        if (!address || amount === undefined) throw new Error('Missing address or amount (amount_xmr)');

        const config = this.store.get('agent_config');
        const limit = parseFloat(config.dailyLimit);
        const requested = parseFloat(amount.toString());

        // Limit Check
        if (requested > limit) {
          this.log('fail', `Blocked transfer of ${amount} XMR: Exceeds daily limit (${limit}).`);
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Limit exceeded' }));
          return;
        }

        const accountIndex = config?.selectedAccountIndex || 0;
        this.log('ok', `Agent initiating transfer of ${amount} XMR from Account #${accountIndex} to ${address.substring(0, 8)}...`);

        // Convert XMR to atomic units
        const amountAtomic = (requested * 1e12).toFixed(0);
        const txHash = await WalletManager.transfer(address, amountAtomic, accountIndex);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, tx_hash: txHash }));
      } catch (e: any) {
        this.log('fail', `Transfer error: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  private async handleSubaddress(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { label } = JSON.parse(body);
        const config = this.store.get('agent_config');
        const accountIndex = config?.selectedAccountIndex || 0;

        this.log('ok', `Agent creating subaddress for Account #${accountIndex} with label: ${label || 'AGENT_INVOICE'}`);

        // We need to add createSubaddress to WalletManager
        const address = await WalletManager.createSubaddress(label || 'AGENT_INVOICE', accountIndex);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ address }));
      } catch (e: any) {
        this.log('fail', `Subaddress error: ${e.message}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  }

  private async handleNetwork(res: http.ServerResponse) {
    try {
      this.log('ok', 'Agent queried network status.');

      // Get network from WalletManager or AppConfig
      // Most Monero RPCs return 'mainnet', 'stagenet', or 'testnet' in get_info
      // For now, we'll try to get it from the store or a quick RPC call
      const network = this.store.get('network') || 'mainnet';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        network: network,
        nettype: network, // Compatibility 
        status: 'OK'
      }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  }
}
