// src/main/WalletManager.ts
import { net } from 'electron';

const RPC_URL = 'http://127.0.0.1:18082/json_rpc';

export class WalletManager {
  /**
   * Core RPC communication: Uses native net.fetch to bypass Node.js proxy pitfalls
   */
  private static async callRpc(method: string, params: any = {}): Promise<any> {
    try {
      const response = await net.fetch(RPC_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: '0',
          method,
          params
        })
      });

      if (!response.ok) {
        throw new Error(`RPC Server error: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message);
      }
      return data.result;
    } catch (error: any) {
      console.error(`[WalletManager] RPC Failure (${method}):`, error.message);
      throw error;
    }
  }

  /**
   * Create a new local vault file
   */
  public static async createWallet(filename: string, password: string) {
    return this.callRpc('create_wallet', {
      filename,
      password,
      language: 'English'
    });
  }

  /**
   * Restore wallet from mnemonic seed
   */
  public static async restoreWallet(filename: string, password: string, seed: string, restoreHeight: number, language: string = 'English') {
    return this.callRpc('restore_deterministic_wallet', {
      filename,
      password,
      seed,
      restore_height: restoreHeight,
      language
    });
  }

  /**
   * Open an existing physical vault file
   */
  public static async openWallet(filename: string, password: string) {
    await this.closeWallet().catch(() => { });
    return this.callRpc('open_wallet', { filename, password });
  }

  /**
   * Safely close wallet (this forces the RPC engine to flush in-memory data to the .keys file on disk)
   */
  public static async closeWallet() {
    try {
      // Force store to save sync progress to disk before closing 
      await this.callRpc('store', {}).catch(() => { });
      return await this.callRpc('close_wallet', {});
    } catch (error: any) {
      if (error.message?.includes('No wallet file')) {
        return { success: true };
      }
      throw error;
    }
  }

  /**
   * Get mnemonic (for backup)
   */
  public static async getMnemonic() {
    const res = await this.callRpc('query_key', { key_type: 'mnemonic' });
    return res.key;
  }
}