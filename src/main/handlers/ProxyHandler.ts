import { ipcMain } from 'electron';
import http from 'http';
import https from 'https';
import { URL } from 'url';

export function registerProxyHandlers(store: any, torAgent: any, isTorReadyRef: { current: boolean }) {
  
  async function tacticalFetch(url: string, options: any, useTor: boolean) {
    if (useTor) {
      if (!isTorReadyRef.current) throw new Error('TOR_NOT_READY');
      
      const parsedUrl = new URL(url);
      const isHttps = parsedUrl.protocol === 'https:';
      const requestModule = isHttps ? https : http;

      return new Promise((resolve, reject) => {
        const req = requestModule.request({
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers: options.headers,
          agent: torAgent
        }, (res: any) => {
          let body = '';
          res.on('data', (chunk: any) => body += chunk);
          res.on('end', () => {
            try {
              resolve({ 
                status: res.statusCode, 
                json: async () => JSON.parse(body) 
              });
            } catch (e) {
              reject(new Error('INVALID_JSON_RESPONSE'));
            }
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
      if (useTor && !isTorReadyRef.current) return { error: 'TOR_BOOTSTRAPPING' };

      const fetchOptions: any = {
        method,
        headers: {
          'User-Agent': 'curl/7.64.1', 
          'Accept': 'application/json',
          ...headers
        }
      };

      if (data) fetchOptions.body = typeof data === 'string' ? data : JSON.stringify(data);

      const response: any = await tacticalFetch(url, fetchOptions, useTor);
      const resultData = await response.json();
      return { data: resultData, status: response.status };
    } catch (error: any) {
      return { error: error.message };
    }
  });
}
