/**
 * Vigil strike wallet — a deliberately small EVM burner wallet used to
 * auto-fund SNIPE trades when a price trigger fires.
 *
 * - One key per identity, generated locally, AES-GCM-encrypted with the
 *   vault password, persisted via IPC (main process stores opaque blobs).
 * - All RPC traffic goes through the renderer fetch stack, which already
 *   follows the app-wide Tor/system proxy session settings.
 * - This is intentionally NOT the Monero vault: pre-fund only what you
 *   plan to deploy.
 */
import { ethers } from 'ethers';
import { EvmStealthEngine } from '@kyc-rip/stealth-engines/evm';
import type { StealthEnvironment } from '@kyc-rip/stealth-engines';
import { getTokenConfig, isNativeEVM, getRpcUrl } from '@kyc-rip/stealth-engines/chains';
import { createTrade } from './swap';
import { encryptStrikeKey, decryptStrikeKey } from '../utils/strikeKeyCrypto';

export interface StrikeBalances {
  eth: string;
  tokens: Record<string, string>; // ticker -> formatted balance
}

export interface GasCheck {
  ok: boolean;
  requiredEth: string;
  haveEth: string;
  missingEth?: string;
}

const desktopStealthEnv: StealthEnvironment = {
  createTrade: createTrade as unknown as StealthEnvironment['createTrade'],
  getTokenConfig,
  isNativeEVM,
};

export type StrikeLogger = (msg: string, type?: 'info' | 'success' | 'warn' | 'process' | 'error') => void;

export class StrikeWallet {
  private engine: EvmStealthEngine;
  private network: string;
  private identityId: string;

  private constructor(engine: EvmStealthEngine, network: string, identityId: string) {
    this.engine = engine;
    this.network = network;
    this.identityId = identityId;
  }

  /**
   * Load the identity's strike key (decrypting with the vault password) or
   * generate + persist a fresh one. Returns the wallet plus whether it was
   * newly created (callers should prompt for a key backup on creation).
   */
  static async createOrLoad(
    identityId: string,
    vaultPassword: string,
    network: string,
    logger: StrikeLogger = () => { }
  ): Promise<{ wallet: StrikeWallet; address: string; created: boolean }> {
    const rpcUrl = getRpcUrl(network);
    let privateKey: string;
    let created = false;

    const blob = await window.api.vigilGetStrikeKey(identityId);
    if (blob) {
      privateKey = await decryptStrikeKey(blob, vaultPassword);
    } else {
      privateKey = ethers.Wallet.createRandom().privateKey;
      const newBlob = await encryptStrikeKey(privateKey, vaultPassword);
      const res = await window.api.vigilSaveStrikeKey(identityId, newBlob);
      if (!res.success) throw new Error(res.error || 'Failed to persist strike key');
      created = true;
    }

    const engine = new EvmStealthEngine(logger, desktopStealthEnv);
    const address = await engine.init(rpcUrl, privateKey);
    return { wallet: new StrikeWallet(engine, network, identityId), address, created };
  }

  getAddress(): string {
    return this.engine.getAddress();
  }

  async getBalances(tickers: string[]): Promise<StrikeBalances> {
    const { total: eth } = await this.engine.getBalance();
    const tokens: Record<string, string> = {};
    for (const ticker of tickers) {
      if (isNativeEVM(ticker)) continue;
      const cfg = getTokenConfig(ticker, this.network);
      tokens[ticker] = cfg ? await this.engine.getTokenBalance(cfg.address) : '0';
    }
    return { eth, tokens };
  }

  /** Check the burner holds enough ETH for gas (with the engine's volatility buffer). */
  async checkGas(): Promise<GasCheck> {
    const requiredEth = await this.engine.getEstimatedGasBuffer();
    const { total: haveEth } = await this.engine.getBalance();
    const ok = parseFloat(haveEth) >= parseFloat(requiredEth);
    return {
      ok,
      requiredEth,
      haveEth,
      missingEth: ok ? undefined : (parseFloat(requiredEth) - parseFloat(haveEth)).toFixed(6),
    };
  }

  /** Send `amount` of `ticker` to a swap deposit address. Waits 1 confirmation. */
  async sendToken(toAddress: string, amount: number, ticker: string): Promise<string> {
    return this.engine.transfer(toAddress, amount, ticker, this.network);
  }

  /** Sweep leftovers (token + remaining ETH minus gas) to a user address. */
  async refund(toAddress: string, ticker?: string): Promise<string> {
    const tokenInfo = ticker && !isNativeEVM(ticker)
      ? { address: getTokenConfig(ticker, this.network)?.address, ticker }
      : undefined;
    return this.engine.sweep(toAddress, tokenInfo);
  }

  /** Re-authenticate and reveal the raw private key for backup/export. */
  async exportKey(vaultPassword: string): Promise<string> {
    const blob = await window.api.vigilGetStrikeKey(this.identityId);
    if (!blob) throw new Error('No strike key stored for this identity');
    return decryptStrikeKey(blob, vaultPassword);
  }
}

/**
 * Re-encrypt the strike key when the vault password changes, keeping the
 * burner recoverable. Call with both passwords during a password-change flow.
 */
export async function reencryptStrikeKey(identityId: string, oldPassword: string, newPassword: string): Promise<boolean> {
  const blob = await window.api.vigilGetStrikeKey(identityId);
  if (!blob) return false;
  const privateKey = await decryptStrikeKey(blob, oldPassword);
  const newBlob = await encryptStrikeKey(privateKey, newPassword);
  const res = await window.api.vigilSaveStrikeKey(identityId, newBlob);
  if (!res.success) throw new Error(res.error || 'Failed to re-encrypt strike key');
  return true;
}
