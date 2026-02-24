import { MoneroAccount } from '../contexts/VaultContext';
import { RpcClient } from './rpcClient';

export interface Transaction {
  id: string;
  amount: string;
  type: 'in' | 'out' | 'pending';
  timestamp: number;
  address: string;
  confirmations: number;
  subaddr_index?: { major: number; minor: number };
  accountIndex?: number;
  fee?: string;
  height?: number;
  paymentId?: string;
  note?: string;
  unlockTime?: number;
  doubleSpendSeen?: boolean;
  destinations?: Array<{ address: string; amount: string }>;
}

export const WalletService = {
  /**
   * Fetch all sub-accounts under current wallet (multi-account in GUI)
   */
  async getAccounts(): Promise<MoneroAccount[]> {
    // RPC Method: get_accounts
    const res = await RpcClient.call('get_accounts', {
      all_accounts: true,
      tag: "" // Empty string to fetch all
    });

    return (res.subaddress_accounts || []).map((acc: any) => ({
      index: acc.account_index,
      label: acc.label || `Account #${acc.account_index}`,
      balance: RpcClient.formatXmr(acc.balance),
      unlockedBalance: RpcClient.formatXmr(acc.unlocked_balance),
      baseAddress: acc.base_address
    }));
  },

  async createAccount(label: string = 'NEW_ACCOUNT') {
    const res = await RpcClient.call('create_account', {
      label: label
    });
    return {
      index: res.account_index,
      address: res.address
    };
  },

  async renameAccount(accountIndex: number, newLabel: string) {
    await RpcClient.call('label_account', {
      account_index: accountIndex,
      label: newLabel
    });
  },

  // --- Base State ---
  async getBalance(accountIndex: number) {
    // 🚀 Retrieve detailed list of all accounts
    const balance = await RpcClient.call('get_balance', { account_index: accountIndex });
    return {
      total: RpcClient.formatXmr(balance.total_balance.toString()),
      unlocked: RpcClient.formatXmr(balance.unlocked_balance.toString())
    };
  },

  async getHeight(accountIndex: number) {
    const res = await RpcClient.call('get_height', { account_index: accountIndex });
    return res.height;
  },

  async getAddress(accountIndex: number) {
    const res = await RpcClient.call('get_address', { account_index: accountIndex });
    return {
      primary: res.address,
      all: res.addresses || []
    };
  },

  // --- Transaction Operations ---
  async send(destination: string, amountXmr: number, accountIndex: number) {
    const rawAmount = RpcClient.toAtomic(amountXmr);

    await RpcClient.call('transfer', {
      destinations: [{ destination, amount: rawAmount }],
      account_index: accountIndex,
      priority: 1
    });
  },

  /**
   * Churn: Sweeps all available balance back to self to refresh privacy or unify fragments
   */
  async churn(accountIndex: number) {
    const { primary } = await this.getAddress(accountIndex);
    const res = await RpcClient.call('sweep_all', {
      address: primary,
      account_index: accountIndex,
      ring_size: 16
    });
    return res.tx_hash_list[0];
  },

  /**
   * Sweep All: Extinguish all wallet funds to a specific address
   */
  async sweepAll(destination: string, accountIndex: number) {
    const res = await RpcClient.call('sweep_all', {
      address: destination,
      account_index: accountIndex
    });
    return res.tx_hash_list;
  },

  // --- Data Query ---
  async getTransactions(accountIndex: number): Promise<Transaction[]> {
    const res = await RpcClient.call('get_transfers', {
      in: true,
      out: true,
      pending: true,
      failed: true,
      pool: false, // pool:true forces daemon mempool query — fails over Tor
      account_index: accountIndex,
    });

    const mapTx = (tx: any, type: 'in' | 'out' | 'pending'): Transaction => ({
      id: tx.txid,
      amount: RpcClient.formatXmr(tx.amount),
      type,
      timestamp: tx.timestamp * 1000,
      address: tx.address || '',
      confirmations: tx.confirmations || 0,
      subaddr_index: tx.subaddr_index,
      fee: tx.fee ? RpcClient.formatXmr(tx.fee) : undefined,
      height: tx.height,
      paymentId: tx.payment_id !== '0000000000000000' ? tx.payment_id : undefined,
      note: tx.note,
      unlockTime: tx.unlock_time,
      doubleSpendSeen: tx.double_spend_seen,
      destinations: tx.destinations && tx.destinations.length > 0
        ? tx.destinations.map((d: any) => ({
          address: d.address,
          amount: RpcClient.formatXmr(d.amount)
        }))
        : undefined
    });

    return [
      ...(res.in || []).map((t: any) => mapTx(t, 'in')),
      ...(res.out || []).map((t: any) => mapTx(t, 'out')),
      ...(res.pending || []).map((t: any) => mapTx(t, 'pending')),
    ].map(tx => ({
      ...tx,
      accountIndex: tx.subaddr_index?.major ?? 0,
    })).sort((a, b) => b.timestamp - a.timestamp);
  },

  async createSubaddress(label: string, accountIndex: number) {
    const res = await RpcClient.call('create_address', {
      account_index: accountIndex,
      label
    });
    return res.address;
  },

  async rescan(height: number) {
    return await RpcClient.call('rescan_blockchain', { height }); // C++ RPC rescans from specified height
  },


  async getOutputs(accountIndex: number) {
    try {
      // 🚀 Use incoming_transfers to retrieve all available outputs
      const res = await RpcClient.call('incoming_transfers', {
        account_index: accountIndex,
        transfer_type: 'available',
        verbose: true
      });

      return (res.transfers || []).map((o: any) => ({
        amount: RpcClient.formatXmr(o.amount),
        keyImage: o.key_image,
        isUnlocked: o.unlocked,
        frozen: o.frozen || false,
        spent: false, // If type is "available", it hasn't been spent
        subaddressIndex: o.subaddr_index.minor,
        timestamp: o.timestamp ? o.timestamp * 1000 : Date.now(),
        txid: o.txid
      })).sort((a: any, b: any) => b.timestamp - a.timestamp);

    } catch (e: any) {
      console.error("RPC_METHOD_ERROR: incoming_transfers failed.", e.message);
      return [];
    }
  },

  /**
   * Set subaddress label
   */
  async setSubaddressLabel(index: number, label: string, accountIndex: number) {
    // RPC Method: label_address
    return await RpcClient.call('label_address', {
      account_index: accountIndex,
      index: { major: 0, minor: index },
      label: label
    });
  },

  /**
   * Helper method: fetch full list of subaddresses and format them
   */
  async getSubaddresses(accountIndex: number) {
    const res = await RpcClient.call('get_address', { account_index: accountIndex });
    // res.addresses is an array
    return (res.addresses || []).map((addr: any) => ({
      index: addr.address_index,
      address: addr.address,
      label: addr.label || 'UNTITLED_RECIPIENT',
      balance: RpcClient.formatXmr(addr.balance || 0),
      unlockedBalance: RpcClient.formatXmr(addr.unlocked_balance || 0),
      isUsed: addr.used || false
    }));
  },

  async createSubaddressWithLabel(label: string, accountIndex: number) {
    const address = await this.createSubaddress(label, accountIndex);
    await this.setSubaddressLabel(address.index, label, accountIndex);
    return address;
  },

  async sendTransaction(destination: string, amount: number, accountIndex: number) {
    const tx = await RpcClient.call('transfer', {
      destinations: [{ address: destination, amount: RpcClient.toAtomic(amount) }],
      account_index: accountIndex,
      ring_size: 16
    });

    return tx.tx_hash;
  },

  /**
   * Vanish Coin: Sweeps a single output (identified by its key_image) back to the main account address.
   */
  async vanishCoin(keyImage: string, accountIndex: number = 0) {
    // 1. Get the primary address for this account to sweep back to
    const addressRes = await RpcClient.call('get_address', { account_index: accountIndex, address_index: [0] });
    const primaryAddress = addressRes.address;

    // 2. Perform the single sweep
    const tx = await RpcClient.call('sweep_single', {
      address: primaryAddress,
      key_image: keyImage,
      ring_size: 16
    });

    return tx.tx_hash_list?.[0] || tx.tx_hash;
  }
};