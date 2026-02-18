/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { apiClient, apiClient as client } from './client';
import {
  type BatchQuoteRequest,
  type BatchQuoteResult,
  type BatchOrderResult,
  type ExchangeStatus as TradeStatusCentral
} from "./types";

export type TradeStatus = TradeStatusCentral;
export type { BatchQuoteRequest, BatchQuoteResult, BatchOrderResult };

// --- Shared Interfaces ---
export type ComplianceLevel = 'ANY' | 'STANDARD' | 'STRICT';

export interface ComplianceState {
  kyc: ComplianceLevel;
  log: ComplianceLevel;
}

export interface TradeSupport {
  tx_url: string;
  support_url: string;
  type: string;
  tos: string;
}

export interface TradeDetails {
  provider_logo: string;
  original_eta: number;
  original_amount_to_USD?: number;
  expiresAt?: string;
}

export interface ExchangeRoute {
  provider: string;
  amount_to: number;
  amount_from: number;
  kyc: string;
  log_policy: string;
  insurance: number;
  spread: number;
  fixed: boolean;
  eta: number;
}

export interface ExchangeQuote {
  id: string;
  rate: number;
  amount_from: number;
  amount_to: number;
  min: number;
  max: number;
  provider: string;
  kyc_rating: string;
  eta: number;
  routes?: ExchangeRoute[];
}

// --- 1. Create Trade ---

export interface CreateTradeParams {
  id: string;
  amountFrom: number;
  amountTo: number;
  fromTicker: string;
  fromNetwork: string;
  toTicker: string;
  toNetwork: string;
  destinationAddress: string;
  provider: string;
  fixed?: boolean;
  isPayment?: boolean;
  source?: 'swap' | 'ghost vigil' |  'ghost vigil sweep' | 'dispenser' | 'ghost';
}

export interface ExchangeResponse {
  trade_id: string;
  status: string;
  amount_from: number;
  amount_to: number;
  deposit_amount: number;
  address_provider: string;
  address_user: string;
  ticker_from: string;
  ticker_to: string;
  network_from: string;
  network_to: string;
  provider: string;
  id?: string;
  deposit_address?: string;
}


export interface BridgeEstimate {
  amount_to: string;
  eta: number;
  first_provider: string;
  first_kycrating: string;
  first_logpolicy: string;
  first_insurance: number;
  second_provider: string;
  second_kycrating: string;
  second_logpolicy: string;
  second_insurance: number;
  first_eta: number;
  second_eta: number;

  first_list: string[];
  second_list: string[];
}


export interface BridgeTrade {
  trade_id: string;
  status: string;
  ticker_from: string;
  ticker_to: string;

  network_from: string;
  network_to: string;

  amount_from: number;
  amount_to: number;
  provider: string;
  address_provider?: string;
  address_user?: string;
  address_provider_memo?: string;
  tx_out?: string;

  details?: {
    hashout?: string;
    support?: {
      tx_url?: string;
    };
    provider_logo?: string;
    original_eta?: number;
    second_trade_id?: string;
  };
  quotes?: {
    support?: {
      support_url?: string;
      tx_url?: string;
    }
  };
  confirmations?: number;
  refund_address?: string;
}

/**
 * 1. Create a Swap Trade
 */
export function createTrade(params: CreateTradeParams): Promise<ExchangeResponse> {
  // Mock for Testnets (seth, sxmr, tltc)
  const t = params.fromTicker.toLowerCase();
  if (t === 'seth' || t === 'sxmr' || t === 'tltc') {
    const tradeId = `testnet_real_${Math.random().toString(36).substring(7)}_${Date.now()}`;
    const mockAddrMap: Record<string, string> = {
      'sxmr': "55LTR8KniP4LQGJ9fsSKSvCoZKGvNDYbhY7AgWhNCasZ9nuL6S2ToRKmUnof69xs9snstivivsnNCofLoMBPfSaS7XBsEtC",
      'tltc': "tltc1qpfycydpyrtzkvpgxdzhszhyzpgxdzhszpgxdzhsz", // Mock Bech32
      'seth': "0x000000000000000000000000000000000000dEaD"
    };
    const mockAddr = mockAddrMap[t] || "55LTR8KniP4LQGJ9fsSKSvCoZKGvNDYbhY7AgWhNCasZ9nuL6S2ToRKmUnof69xs9snstivivsnNCofLoMBPfSaS7XBsEtC";

    return Promise.resolve({
      id: tradeId, trade_id: tradeId, status: "waiting",
      amount_from: params.amountFrom, amount_to: params.amountTo,
      deposit_amount: params.amountFrom, deposit_address: mockAddr,
      address_provider: mockAddr, address_user: params.destinationAddress,
      ticker_from: t, ticker_to: params.toTicker,
      network_from: t === 'sxmr' ? "Stagenet" : (t === 'tltc' ? "Testnet" : "Sepolia"),
      network_to: params.toNetwork, provider: "TestnetMock"
    });
  }

  return client<ExchangeResponse>('/v1/exchange/create', {
    body: {
      trade_id: params.id, amount_from: params.amountFrom, amount_to: params.amountTo,
      from_currency: params.fromTicker, from_network: params.fromNetwork,
      to_currency: params.toTicker, to_network: params.toNetwork,
      address_to: params.destinationAddress, fixed_rate: params.fixed || false,
      provider: params.provider, isPayment: params.isPayment || false,
      source: params.source || 'swap'
    }
  });
}

/**
 * 2. Get Swap Trade Status
 */
export function getTradeStatus(id: string) {
  // Mock for Testnets
  if (id.startsWith('testnet_real_')) {
    const parts = id.split('_');
    const timestamp = parseInt(parts[parts.length - 1]);
    const now = Date.now();
    const elapsed = (now - timestamp) / 1000;

    let status = 'waiting';

    // 模拟真实的时间流逝
    if (elapsed > 60) status = 'finished';      // 1分钟后完成
    else if (elapsed > 30) status = 'sending';  // 30秒后发送
    else if (elapsed > 10) status = 'exchanging'; // 10秒后兑换
    else if (elapsed > 0) status = 'confirming';  // 只要 ID 存在，就算 Confirming (因为是 Vigil 模式，钱已经发出去了)

    return Promise.resolve({
      trade_id: id,
      status: status,
      amount_from: 0.1, // 这些数可以随便填，或者存 localStorage 读取
      amount_to: 0.05,
      ticker_from: 'SETH',
      ticker_to: 'SXMR',
      provider: 'Mock_Stagenet_Liquidity',
      tx_out: status === 'finished' ? '540c45...' : undefined,
      deposit_address: '...',
      // ...
    } as any);
  } else if (id.startsWith('test_')) {
    const parts = id.split('_');
    const timestamp = parseInt(parts[parts.length - 1]);
    const now = Date.now();
    const elapsed = now - timestamp;

    let status = 'waiting';
    if (elapsed > 60000) status = 'finished';
    else if (elapsed > 20000) status = 'exchanging';

    return Promise.resolve({
      trade_id: id,
      status: status,
      ticker_from: 'sxmr',
      ticker_to: 'seth',
      amount_from: 0.001,
      amount_to: 3,
      address_provider: 'mock_provider_address',
      address_user: 'mock_user_address',
      provider: 'TestnetMock',
      created_at: new Date(timestamp).toISOString()
    } as any);
  }

  return client<TradeStatus>(`/v1/exchange/status/${id}`);
}

/**
 * 3. Get Real-time Quote
 */
export async function fetchQuote(
  fromTicker: string,
  fromNetwork: string,
  toTicker: string,
  toNetwork: string,
  amountValue: number,
  isReverse: boolean = false,
  kyc: ComplianceLevel = 'ANY',
  log: ComplianceLevel = 'ANY',
): Promise<ExchangeQuote> {
  // Mock for Testnets (seth, sxmr, tltc)
  const t = fromTicker.toLowerCase();
  if (t === 'seth' || t === 'sxmr' || t === 'tltc') {
    const rateMap: Record<string, number> = { 'seth': 3000, 'sxmr': 20000, 'tltc': 70 };
    const rate = rateMap[t] || 100;
    const estimatedAmt = isReverse ? amountValue / rate : amountValue * rate;
    return Promise.resolve({
      id: `mock_quote_${t}_` + Date.now(), rate: rate,
      amount_from: isReverse ? estimatedAmt : amountValue,
      amount_to: isReverse ? amountValue : estimatedAmt,
      min: 0.001, max: 100, provider: "TestnetMock", kyc_rating: "A", eta: 2,
      routes: [{
        provider: "TestnetMock", amount_to: isReverse ? amountValue : estimatedAmt,
        amount_from: isReverse ? estimatedAmt : amountValue,
        kyc: "A", log_policy: "no_logs", insurance: 0, spread: 0.5, fixed: false, eta: 2
      }]
    });
  }

  const params = new URLSearchParams({
    from: fromTicker, from_net: fromNetwork, to: toTicker, to_net: toNetwork,
    amount: amountValue.toString(), type: isReverse ? 'to' : 'from',
    kyc: kycMap[kyc], log: logMap[log],
  });

  return client<ExchangeQuote>(`/v1/exchange/estimate?${params.toString()}`);
}

/**
 * A. 仅批量询价
 */
export async function quoteBatchTrades(
  requests: BatchQuoteRequest[],
  strategy: 'best' | 'diversity' = 'best',
  kyc: ComplianceLevel = 'ANY',
  log: ComplianceLevel = 'ANY',
): Promise<BatchQuoteResult[]> {
  const rawResults = await Promise.all(requests.map(async (req) => {
    try {
      const quote = await fetchQuote(
        req.fromTicker,
        req.fromNetwork,
        req.toTicker,
        req.toNetwork,
        req.amountTo,
        true,
        kyc,
        log
      );

      const validRoutes = quote.routes || [];

      if (validRoutes.length === 0) throw new Error('No compatible providers found, try lower the barrier');
      return { req, quoteId: quote.id, validRoutes, success: true };
    } catch (err: any) {
      return { req, quoteId: '--', validRoutes: [], success: false, error: err.message || 'Quote failed' };
    }
  }));

  const providerUsage: Record<string, number> = {};
  const finalResults: BatchQuoteResult[] = [];

  for (const res of rawResults) {
    if (!res.success || res.validRoutes.length === 0) {
      finalResults.push({
        trade_id: "--", request_id: res.req.id, provider: '', amount_from_estimated: 0,
        amount_to: 0, success: false, error: res.error, original_request: res.req
      });
      continue;
    }

    let selectedRoute: any;
    const bestPrice = res.validRoutes[0].amount_from;

    if (strategy === 'best') {
      selectedRoute = res.validRoutes[0];
    } else {
      const TOLERANCE = 1.05;
      const candidates = res.validRoutes.filter((r: any) => r.amount_from <= bestPrice * TOLERANCE);
      candidates.sort((a: any, b: any) => {
        const usageA = providerUsage[a.provider] || 0;
        const usageB = providerUsage[b.provider] || 0;
        if (usageA !== usageB) return usageA - usageB;
        return a.amount_from - b.amount_from;
      });
      selectedRoute = candidates[0];
    }

    providerUsage[selectedRoute.provider] = (providerUsage[selectedRoute.provider] || 0) + 1;
    finalResults.push({
      request_id: res.req.id, trade_id: res.quoteId, provider: selectedRoute.provider,
      amount_from_estimated: selectedRoute.amount_from, amount_to: res.req.amountTo,
      success: true, original_request: res.req
    });
  }
  return finalResults;
}

/**
 * B. 批量开单
 */
export async function executeBatchTrades(quotes: BatchQuoteResult[], destinationMap: Record<string, string>): Promise<BatchOrderResult[]> {
  const createPromises = quotes.map(async (q) => {
    if (!q.success) {
      return { request_id: q.request_id, trade_id: '', address_provider: '', amount_from: 0, provider: '', status: 'failed' as const, error: q.error };
    }
    try {
      const destAddr = destinationMap[q.request_id];
      const trade = await createTrade({
        id: q.trade_id, amountFrom: q.amount_from_estimated, amountTo: q.amount_to,
        fromTicker: q.original_request.fromTicker, fromNetwork: q.original_request.fromNetwork,
        toTicker: q.original_request.toTicker, toNetwork: q.original_request.toNetwork,
        destinationAddress: destAddr, provider: q.provider, source: "dispenser"
      });
      return {
        request_id: q.request_id, trade_id: trade.trade_id || trade.id || '',
        address_provider: trade.address_provider || trade.deposit_address || '',
        amount_from: Number(trade.amount_from || trade.deposit_amount || 0),
        provider: q.provider, status: 'success' as const, expected_to: q.amount_to
      };
    } catch (err) {
      return { request_id: q.request_id, trade_id: '', address_provider: '', amount_from: 0, provider: q.provider, status: 'failed' as const, error: 'Creation failed' };
    }
  });
  return Promise.all(createPromises);
}


// --- API Service ---
const kycMap: Record<ComplianceLevel, string> = {
  'STRICT': 'A',   // No KYC
  'STANDARD': 'B', // Standard (Exclude C/D)
  'ANY': 'D'       // Allow All
};

const logMap: Record<ComplianceLevel, string> = {
  'STRICT': 'A',   // No Logs
  'STANDARD': 'B', // Short Term Logs (Exclude C/D)
  'ANY': 'C'       // Allow All
};

export const fetchBridgeEstimate = async (from: string, to: string, amount: number, network_from: string = "Mainnet", network_to: string = "Mainnet", kyc: ComplianceLevel, log: ComplianceLevel) => {
  const params = new URLSearchParams({ from, to, network_from, network_to, amount: amount.toString(), type: 'from', kyc: kycMap[kyc], log: logMap[log] });

  console.log(`requesting API: /v1/exchange/bridge/estimate?${params.toString()}`);

  const data = await apiClient<BridgeEstimate>(`/v1/exchange/bridge/estimate?${params.toString()}`, {}, async (res) => {
    if (!res.ok) {
      let errMsg = "Estimate Failed";
      try {
        const errData = await res.json();
        if (errData.error) errMsg = errData.error;
      } catch {
        errMsg = await res.text() || res.statusText;
      }
      throw new Error(errMsg.split('error":')?.[1]?.replaceAll(/["\\}]/g, '') || errMsg);
    }
    return await res.json() as BridgeEstimate;
  });

  return data;
};

export const createBridgeTrade = async (payload: {
  from_currency: string;
  from_network: string;
  to_currency: string;
  to_network: string;
  amount_from: number;
  address_to: string;
  refund_address: string;
}) => {
  try {
    const data = await apiClient<BridgeTrade[]>(`/v1/exchange/bridge/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return data;
  } catch (e) {
    console.error("Failed to create bridge:", e);
    throw e;
  }
};

export const fetchBridgeStatus = async (id: string) => {
  try {
    const trade1 = await apiClient<BridgeTrade>(`/v1/exchange/status/${id}`);
    if (trade1.details && trade1.details.second_trade_id) {
      try {
        const trade2 = await apiClient<BridgeTrade>(`/v1/exchange/status/${trade1.details.second_trade_id}`)
        return [trade1, trade2] as BridgeTrade[];
      } catch (e) {
        console.warn("Failed to fetch second leg of bridge:", e);
      }
    }
    return [trade1] as BridgeTrade[];
  } catch (e) {
    console.error("Failed to fetch bridge status:", e);
    throw e;
  }
};