import { SocksProxyAgent } from 'socks-proxy-agent';
import yaml from 'js-yaml';

const NODES_YAML_URL = 'https://raw.githubusercontent.com/feather-wallet/feather-nodes/master/nodes.yaml';

// Hardcoded fallbacks in case GitHub is unreachable
const FALLBACK_DATA = {
  mainnet: {
    tor: ["loveanvthlsepingenr7opdqy6nlhn5jidwvzzxfmwsw2rry5mn2gfqd.onion:18089", "cakexmrl7bonq7ovjka5kuwuyd3f7qnkz6z6s6dmsy3uckwra7bvggyd.onion:18081"],
    clearnet: ["https://node.community.as65535.net", "https://monero.herominers.com:18081", "xmr-node.cakewallet.com:18081"]
  },
  stagenet: {
    tor: [
      "loveanvthlsepingenr7opdqy6nlhn5jidwvzzxfmwsw2rry5mn2gfqd.onion:18089",
      "ct36dsbe3oubpbebpxmiqz4uqk6zb6nhmkhoekileo4fts23rvuse2qd.onion:38081"
    ],
    clearnet: [
      "https://rpc-stagenet.kyc.rip",
      "https://stagenet.xmr.ditatompel.com",
      "http://node.monerodevs.org:38089",
      "http://stagenet.melo.tools:18081"
    ]
  }
};

interface MoneroNode {
  url: string;
  latency: number;
  height: number;
  isActive: boolean;
}

export class NodeManager {
  private bestNode: string | null = null;
  private torAgent = new SocksProxyAgent('socks5h://127.0.0.1:9050');
  private nodeCache: any = FALLBACK_DATA;

  private async fetchRemoteNodes() {
    try {
      console.log('[NodeRadar] Syncing latest nodes from GitHub...');
      const res = await fetch(NODES_YAML_URL, { signal: AbortSignal.timeout(10000) });
      const text = await res.text();
      const doc = yaml.load(text) as any;
      
      const parsed: any = { mainnet: { tor: [], clearnet: [] }, stagenet: { tor: [], clearnet: [] } };

      const extract = (network: string, type: string) => {
        const source = doc[network]?.[type];
        const fallbacks = (FALLBACK_DATA as any)[network]?.[type] || [];
        if (!source) return fallbacks;
        return Array.from(new Set([...Object.values(source).flat() as string[], ...fallbacks]));
      };

      parsed.mainnet.tor = extract('mainnet', 'tor');
      parsed.mainnet.clearnet = extract('mainnet', 'clearnet');
      parsed.stagenet.tor = extract('stagenet', 'tor');
      parsed.stagenet.clearnet = extract('stagenet', 'clearnet');

      this.nodeCache = parsed;
      console.log(`[NodeRadar] Sync Complete.`);
    } catch (e: any) {
      console.warn(`[NodeRadar] GitHub Sync failed (${e.message}). Using local fallbacks.`);
    }
  }

  public async scout(isStagenet: boolean = false, useTor: boolean = false) {
    if (this.nodeCache === FALLBACK_DATA) await this.fetchRemoteNodes();

    const network = isStagenet ? this.nodeCache.stagenet : this.nodeCache.mainnet;
    const rawSeeds = useTor ? network.tor : network.clearnet;
    const seeds = rawSeeds.map((s: string) => s.startsWith('http') ? s : `http://${s}`);

    console.log(`[NodeRadar] Scouting ${seeds.length} ${useTor ? 'TOR' : 'CLEAR'} nodes...`);

    const results = await Promise.all(seeds.slice(0, 15).map(async (url: string) => {
      const start = Date.now();
      try {
        const body = JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_height' });
        let data: any;

        if (useTor) {
          // Tactical fallback for SOCKS compatibility
          data = await new Promise((resolve, reject) => {
            const http = require('http');
            const { URL } = require('url');
            const parsedUrl = new URL(`${url}/json_rpc`);
            const req = http.request({
              hostname: parsedUrl.hostname,
              port: parsedUrl.port || 80,
              path: parsedUrl.pathname,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              agent: this.torAgent,
              timeout: 15000
            }, (res: any) => {
              let b = '';
              res.on('data', (d: any) => b += d);
              res.on('end', () => {
                try { resolve(JSON.parse(b)); } 
                catch (e) { reject(e); }
              });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
            req.write(body);
            req.end();
          });
        } else {
          const res = await fetch(`${url}/json_rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: body,
            signal: AbortSignal.timeout(8000)
          });
          data = await res.json();
        }
        
        return { url, latency: Date.now() - start, height: data.result.height, isActive: true };
      } catch (e) {
        return { url, latency: 9999, height: 0, isActive: false };
      }
    }));

    const healthyNodes = results.filter(n => n.isActive).sort((a, b) => {
      if (b.height !== a.height) return b.height - a.height;
      return a.latency - b.latency;
    });

    if (healthyNodes.length > 0) {
      this.bestNode = healthyNodes[0].url;
      console.log(`[NodeRadar] Elected: ${this.bestNode} (${healthyNodes[0].latency}ms)`);
    } else {
      this.bestNode = seeds[0];
    }
    return this.bestNode;
  }

  public getBestNode() {
    return this.bestNode || this.nodeCache.mainnet.clearnet[0];
  }
}
