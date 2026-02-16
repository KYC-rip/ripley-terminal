import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';

const NODE_DATA = {
  mainnet: {
    tor: [
      "loveanvthlsepingenr7opdqy6nlhn5jidwvzzxfmwsw2rry5mn2gfqd.onion:18089",
      "dtrnd4in2igrtfx2c45ghf2drns3doddmcsfy6b5gjw5iinukd33slqd.onion:18081",
      "cakexmrl7bonq7ovjka5kuwuyd3f7qnkz6z6s6dmsy3uckwra7bvggyd.onion:18081",
      "plowsof3t5hogddwabaeiyrno25efmzfxyro2vligremt7sxpsclfaid.onion:18089",
      "ravfxmrzi3eet62s4nkuu5sgpq6otgtffluk3ylb2kuvimtb34sonryd.onion:18089",
      "mhfsxznn5pi4xuxohj5k7unqp73sa6d44mbeewbpxnm25z3wzfogcfyd.onion:18081",
      "trocadorh642rks54sxufwy4kys23mrsgof3axowyro5ljb2dkgdlmad.onion:18089"
    ],
    clearnet: [
      "node3-us.monero.love:18081",
      "node2-eu.monero.love:18089",
      "xmr-node.cakewallet.com:18081",
      "node.monerodevs.org:18089",
      "ravfx.its-a-node.org:18081",
      "rucknium.me:18081",
      "selsta1.featherwallet.net:18081",
      "node.sethforprivacy.com:18089",
      "node.trocador.app:18089"
    ]
  },
  stagenet: {
    tor: [
      "ct36dsbe3oubpbebpxmiqz4uqk6zb6nhmkhoekileo4fts23rvuse2qd.onion:38081",
      "plowsof3t5hogddwabaeiyrno25efmzfxyro2vligremt7sxpsclfaid.onion:38089"
    ],
    clearnet: [
      "xmr-lux.boldsuck.org:38081",
      "node.sethforprivacy.com:38089",
      "node2.sethforprivacy.com:38089",
      "stagenet.melo.tools:18081"
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

  public async scout(isStagenet: boolean = false, useTor: boolean = false) {
    const network = isStagenet ? NODE_DATA.stagenet : NODE_DATA.mainnet;
    const rawSeeds = useTor ? network.tor : network.clearnet;
    
    // Normalize URLs
    const seeds = rawSeeds.map(s => s.startsWith('http') ? s : `http://${s}`);

    console.log(`[NodeRadar] Scouting ${seeds.length} ${useTor ? 'TOR' : 'CLEAR'} nodes for ${isStagenet ? 'STAGENET' : 'MAINNET'}...`);

    const results = await Promise.all(seeds.map(async (url) => {
      const start = Date.now();
      try {
        // Important: If using Tor mode, we must scout via our local Tor Agent
        const res = await axios.post(`${url}/json_rpc`, {
          jsonrpc: '2.0', id: '0', method: 'get_height'
        }, { 
          timeout: useTor ? 15000 : 5000,
          httpsAgent: useTor ? this.torAgent : undefined,
          httpAgent: useTor ? this.torAgent : undefined
        });
        
        return {
          url,
          latency: Date.now() - start,
          height: res.data.result.height,
          isActive: true
        };
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
      // Fallback if no nodes respond (e.g. Tor not ready)
      this.bestNode = seeds[0];
    }
    
    return this.bestNode;
  }

  public getBestNode() {
    return this.bestNode || 'https://node.community.as65535.net';
  }
}
