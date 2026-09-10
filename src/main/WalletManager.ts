// src/main/WalletManager.ts
import { net } from 'electron';

const RPC_URL = 'http://127.0.0.1:18082/json_rpc';

// Monero base58: 8-byte chunks → 11 chars (last chunk shorter), big-endian per chunk.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 9, 10, 11];
function moneroBase58Decode(str: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < str.length; i += 11) {
    const block = str.slice(i, i + 11);
    const size = B58_ENCODED_BLOCK_SIZES.indexOf(block.length);
    if (size < 0) throw new Error('Invalid base58 block length');
    let n = 0n;
    for (const c of block) {
      const d = B58.indexOf(c);
      if (d < 0) throw new Error('Invalid base58 character');
      n = n * 58n + BigInt(d);
    }
    for (let j = size - 1; j >= 0; j--) { out.push(Number((n >> BigInt(8 * j)) & 0xffn)); }
  }
  return Uint8Array.from(out);
}

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

  /**
   * Native key material (parity with the Tauri `get_wallet_keys` command). Private
   * keys come from `query_key`; the public keys are read straight out of the PRIMARY
   * address (its base58 body is exactly spend_pub ‖ view_pub — a subaddress would NOT
   * decode to the wallet keys, so account 0 / index 0 is required here). A watch-only
   * wallet has no spend key: `query_key spend_key`/`mnemonic` fail, so those are null.
   */
  public static async getKeys() {
    const privateViewKey: string = (await this.callRpc('query_key', { key_type: 'view_key' })).key;
    let privateSpendKey: string | null = null;
    let mnemonic: string | null = null;
    try {
      privateSpendKey = (await this.callRpc('query_key', { key_type: 'spend_key' })).key;
      mnemonic = (await this.callRpc('query_key', { key_type: 'mnemonic' })).key;
    } catch {
      privateSpendKey = null;
      mnemonic = null;
    }
    const address: string = (await this.callRpc('get_address', { account_index: 0, address_index: [0] })).address;
    const body = moneroBase58Decode(address);
    // [0] = network tag, [1..33] = public spend, [33..65] = public view, then 4 checksum bytes.
    if (body.length < 65) throw new Error('Primary address did not decode to a standard address');
    const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return {
      address,
      network: 'mainnet',
      viewOnly: privateSpendKey === null,
      restoreHeight: 0,
      publicSpendKey: hex(body.subarray(1, 33)),
      publicViewKey: hex(body.subarray(33, 65)),
      privateViewKey,
      privateSpendKey,
      mnemonic,
    };
  }

  /**
   * Get balance for a specific account
   */
  public static async getBalance(accountIndex: number = 0) {
    const res = await this.callRpc('get_balance', { account_index: accountIndex });
    // Handle both 'balance' (standard) and 'total_balance' (GUI variant)
    return {
      total: res.balance !== undefined ? res.balance : res.total_balance,
      unlocked: res.unlocked_balance
    };
  }

  /**
   * Perform a transfer from a specific account
   */
  public static async transfer(destination: string, amountAtomic: string, accountIndex: number = 0) {
    const res = await this.callRpc('transfer', {
      destinations: [{ address: destination, amount: amountAtomic }],
      account_index: accountIndex,
      priority: 0,
      ring_size: 16
    });
    return res.tx_hash;
  }

  /**
   * Create subaddress for a specific account
   */
  public static async createSubaddress(label: string, accountIndex: number = 0) {
    const res = await this.callRpc('create_address', {
      account_index: accountIndex,
      label
    });
    return res.address;
  }

  /**
   * Generate a transaction proof for a specific TXID and recipient address
   * @param txid Transaction ID
   * @param address Recipient address
   * @param message Nonce or message to include in the proof
   */
  public static async getTxProof(txid: string, address: string, message: string = '') {
    const res = await this.callRpc('get_tx_proof', {
      txid,
      address,
      message
    });
    return res.signature;
  }
}