// src/main/NodeManager.ts
import { app, net, session } from 'electron';
import fs from 'fs';
import path from 'path';
import { NodeList } from './types';

// Fallback built-in nodes
import fallbackNodes from '../../resources/nodes.json';

const GITHUB_NODES_URL = 'https://raw.githubusercontent.com/KYC-rip/ghost-terminal/main/resources/nodes.json';

export class NodeManager {
  private localNodesPath: string;
  private currentNodes: NodeList;
  public static daemonHeight: number = 0;
  public static activeNodeStr: string = '';
  public static activeNodeLabel: string = '';

  constructor() {
    this.localNodesPath = path.join(app.getPath('userData'), 'latest_nodes.json');
    this.currentNodes = fallbackNodes as NodeList;
  }

  // 🔄 1. Hot update from GitHub (native Chromium engine)
  public async fetchRemoteNodes(): Promise<void> {
    try {
      console.log('[NodeManager] 📡 Requesting latest node whitelist from GitHub...');

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout control

      const response = await net.fetch(GITHUB_NODES_URL, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP Status abnormal: ${response.status}`);

      // Parse JSON (remote is now our own nodes.json)
      const jsonText = await response.text();
      const parsedData = JSON.parse(jsonText) as NodeList;

      if (parsedData && parsedData.mainnet) {
        this.currentNodes = parsedData;
        fs.writeFileSync(this.localNodesPath, JSON.stringify(this.currentNodes, null, 2));
        console.log('[NodeManager] 🟢 Successfully fetched and cached remote nodes!');
      } else {
        throw new Error('YAML format mismatch');
      }
    } catch (error: any) {
      console.warn(`[NodeManager] 🟡 Unable to connect to remote GitHub (${error.message}), attempting to load local cache...`);
      this.loadLocalNodes(); // Fallback to local cache
    }
  }

  private loadLocalNodes() {
    try {
      if (fs.existsSync(this.localNodesPath)) {
        const data = fs.readFileSync(this.localNodesPath, 'utf-8');
        const parsed = JSON.parse(data);

        // 🛡️ Migration check: If the nodes are in the old flat array format, ignore the cache
        // to force the application to use the new nested built-in nodes.json
        if (parsed.mainnet && Array.isArray(parsed.mainnet.tor)) {
          console.log('[NodeManager] Stale flat nodes detected in cache. Wiping to force migration.');
          fs.unlinkSync(this.localNodesPath);
          // After wiping, we'll fall through to using fallbackNodes or re-fetch
          return;
        }

        this.currentNodes = parsed;
        console.log('[NodeManager] 🟢 Loaded nodes from local cache.');
      } else {
        console.warn('[NodeManager] 🟡 Cache does not exist, using factory fallback nodes.');
        this.currentNodes = fallbackNodes as NodeList;
      }
    } catch (error) {
      console.error('[NodeManager] 🔴 Error loading local nodes, using factory fallback:', error);
      this.currentNodes = fallbackNodes as NodeList;
    }
  }

  public async findFastestNode(network: string = 'mainnet', mode: 'tor' | 'clearnet' = 'tor'): Promise<{ address: string, label: string }> {
    const rawNodes = this.currentNodes[network]?.[mode];

    if (!rawNodes) {
      throw new Error(`No ${mode} nodes found for network: ${network}`);
    }

    // 🔄 Data Normalizer: Handle both Feather's Object grouping and standard Arrays
    let candidates: { address: string, label: string }[] = [];

    if (Array.isArray(rawNodes)) {
      candidates = rawNodes.map(addr => ({ address: addr, label: 'WHITELIST' }));
    } else if (typeof rawNodes === 'object') {
      // Flattens { providerA: ['url1'], providerB: ['url2'] } -> [{ address: 'url1', label: 'providerA' }, ...]
      for (const [label, addresses] of Object.entries(rawNodes)) {
        if (Array.isArray(addresses)) {
          addresses.forEach(addr => candidates.push({ address: addr, label }));
        }
      }
    }

    if (candidates.length === 0) {
      throw new Error(`Node list is empty for ${mode} on ${network}`);
    }

    // Shuffle and pick up to 10 candidates for the race
    const selectedCandidates = candidates.sort(() => 0.5 - Math.random()).slice(0, 20);
    console.log(`[NodeManager] Racing candidates: ${selectedCandidates.map(c => c.address).join(', ')}`);

    const racePromises = selectedCandidates.map(node =>
      this.pingNode(node.address).then(addr => ({ address: addr, label: node.label }))
    );

    try {
      const winner = await Promise.any(racePromises);
      console.log(`[NodeManager] Fastest node selected: ${winner.address} (${winner.label})`);
      NodeManager.activeNodeLabel = winner.label;
      return winner;
    } catch (error) {
      throw new Error('Network paralyzed: All candidate nodes failed to respond.');
    }
  }

  // 🚀 3. RPC Probe (controlled by global proxy settings in index.ts)
  public async pingNode(nodeStr: string): Promise<string> {
    return new Promise(async (resolve, reject) => {

      const currentProxy = await session.defaultSession.resolveProxy(nodeStr);
      console.log(`[NodeManager] Request for ${nodeStr} will go through proxy: ${currentProxy}`);

      try {
        let baseUrl = nodeStr.trim();
        if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
          // 🛡️ Monero Protocol Intelligence: Auto-detect secure ports
          if (baseUrl.endsWith(':18089') || baseUrl.endsWith(':443')) {
            baseUrl = `https://${baseUrl}`;
          } else {
            baseUrl = `http://${baseUrl}`;
          }
        }
        const url = `${baseUrl.replace(/\/$/, '')}/json_rpc`;

        console.log(`[NodeManager] Pinging node: ${url}`);

        const controller = new AbortController();
        // Give Tor/Proxies more time to negotiate DNS and TLS handshakes
        const timeoutMs = currentProxy !== 'DIRECT' ? 20000 : 8000;
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const response = await net.fetch(url, {
          method: 'POST',
          body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          bypassCustomProtocolHandlers: true,
          credentials: 'omit',
          cache: 'no-store'
        });
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`RPC interface access denied (${response.status})`);

        const data = await response.json();
        if (data?.result?.status === 'OK') {
          // Store daemon height for sync progress calculation
          if (data.result.height) {
            NodeManager.daemonHeight = data.result.height;
          }
          NodeManager.activeNodeStr = nodeStr;
          resolve(nodeStr);
        } else {
          reject(new Error('RPC response format abnormal'));
        }
      } catch (error: any) {
        console.warn(`[NodeManager] pingNode failed for ${nodeStr}: ${error.message}`);
        reject(error);
      }
    });
  }

  // 🔄 4. Dynamic height refresh (for SyncWatcher polling)
  public static async fetchDaemonHeight(): Promise<number> {
    if (!this.activeNodeStr) return this.daemonHeight;
    try {
      let baseUrl = this.activeNodeStr.trim();
      if (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://')) {
        if (baseUrl.endsWith(':18089') || baseUrl.endsWith(':443')) {
          baseUrl = `https://${baseUrl}`;
        } else {
          baseUrl = `http://${baseUrl}`;
        }
      }
      const url = `${baseUrl.replace(/\/$/, '')}/json_rpc`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // Longer timeout to prevent disconnection
      const response = await net.fetch(url, {
        method: 'POST',
        body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_info' }),
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const data = await response.json();
        if (data?.result?.height) {
          this.daemonHeight = data.result.height;
        }
      }
    } catch (e) {
      // Ignore on failure; UI continues showing last known height
    }
    return this.daemonHeight;
  }
}