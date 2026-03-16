/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useEffect, useRef, useCallback } from 'react';
import { createTrade, type ComplianceState, type ComplianceLevel, type ExchangeRoute } from '../services/swap';
import { getApiBase } from '../services/client';
import { useFiatValue } from './useFiatValue';
import { useVault } from './useVault';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EngineState = 'IDLE' | 'WATCHING' | 'TRIGGERED' | 'EXECUTING' | 'COMPLETED' | 'ERROR';

export interface VigilSession {
  mode: 'SNIPE' | 'EJECT';
  config: {
    triggerPrice: string;
    stopPrice?: string;
    amount: string;
    targetAddress: string;
    memo?: string;
    inputCurrency?: { ticker: string; network: string; memo?: boolean };
    outputCurrency?: { ticker: string; network: string; memo?: boolean };
    compliance: ComplianceState;
  };
  state: EngineState;
}

interface VigilTrigger {
  id: string;
  operator: '>=' | '<=';
  price: number;
}

interface TriggerPayload {
  provider: string;
  engine: string;
  eta: number;
  amount_to: number;
  krakenPrice: number;
  triggerId: string;
  quote: ExchangeRoute;
}

interface LogEntry {
  id: number;
  time: string;
  text: string;
  type: 'info' | 'success' | 'warn' | 'process' | 'error';
}

interface EstimateResponse {
  amount_to: number;
  routes: ExchangeRoute[];
}

interface DepositInfo {
  address: string;
  amount: number;
  ticker: string;
  memo?: string;
}

// ---------------------------------------------------------------------------
// Compliance Mapping
// ---------------------------------------------------------------------------

const kycMap: Record<string, string> = { 'STRICT': 'A', 'STANDARD': 'B', 'ANY': 'D' };
const logMap: Record<string, string> = { 'STRICT': 'A', 'STANDARD': 'B', 'ANY': 'C' };

const getPrivacyParams = (c: ComplianceState) => ({
  kyc: kycMap[c.kyc] || 'D',
  log: logMap[c.log] || 'C',
});

// ---------------------------------------------------------------------------
// Kraken WebSocket Helpers
// ---------------------------------------------------------------------------

const KRAKEN_WS = 'wss://ws.kraken.com';

/**
 * Derives the Kraken monitoring pair from swap currencies.
 * e.g. SNIPE USDT->XMR  => "XMR/USD"
 *      EJECT XMR->USDT   => "XMR/USD"
 */
const getKrakenMonitoringPair = (mode: 'SNIPE' | 'EJECT', from: string, to: string): string => {
  const clean = (t: string) =>
    t.toUpperCase()
      .replace(/S(XMR|ETH)/i, '$1')
      .replace('USDT', 'USD')
      .replace('USDC', 'USD')
      .replace('DAI', 'USD');

  const cFrom = clean(from);
  const cTo = clean(to);

  let subject = mode === 'SNIPE' ? cTo : cFrom;
  if (['USD', 'EUR'].includes(subject)) {
    subject = mode === 'SNIPE' ? cFrom : cTo;
  }
  return `${subject}/USD`;
};

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useVigilEngine() {
  // --- Core state ---
  const [state, setState] = useState<EngineState>('IDLE');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [executionStatus, setExecutionStatus] = useState<string>('');
  const [progress, setProgress] = useState<number>(0);
  const [activeSession, setActiveSession] = useState<VigilSession | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [completedTrade, setCompletedTrade] = useState<{
    id: string;
    amount: string;
    txHash?: string;
    inputCurrency: any;
    outputCurrency: any;
  } | null>(null);
  const [depositInfo, setDepositInfo] = useState<DepositInfo | null>(null);

  // Kraken live price (from inline WS)
  const [price, setPrice] = useState<number | null>(null);

  // Refs for WS and trigger state (must be refs so callbacks see latest values)
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggersRef = useRef<VigilTrigger[]>([]);
  const isVerifyingRef = useRef(false);
  const isConnectingRef = useRef(false);
  const sessionRef = useRef<VigilSession | null>(null);
  const stateRef = useRef<EngineState>('IDLE');

  // Keep refs in sync
  useEffect(() => { sessionRef.current = activeSession; }, [activeSession]);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Vault context for sending XMR and getting receive address
  const vault = useVault();

  // Fiat price fallback
  const { fiatText: fiatPrice } = useFiatValue('XMR', 1, false);

  const API_BASE = getApiBase();

  // ---------------------------------------------------------------------------
  // Logger
  // ---------------------------------------------------------------------------

  const logger = useCallback((text: string, type: LogEntry['type'] = 'info') => {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    setLogs(prev => [...prev.slice(-50), { id: Date.now(), time: timeStr, text, type }]);

    if (type === 'process' || type === 'error') {
      setExecutionStatus(text);
    }
  }, []);

  // ---------------------------------------------------------------------------
  // Kraken WebSocket (inline, no Web Worker)
  // ---------------------------------------------------------------------------

  const closeWebSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      try { wsRef.current.close(); } catch (_) { /* noop */ }
      wsRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  /**
   * Verify the trigger by fetching the v2 estimate, then fire executeStrike
   * if the route is confirmed.
   */
  const verifyAndExecute = useCallback(async (currentPrice: number, activeTrigger: VigilTrigger) => {
    if (isVerifyingRef.current) return;
    isVerifyingRef.current = true;

    const session = sessionRef.current;
    if (!session) { isVerifyingRef.current = false; return; }

    try {
      console.log(`[Vigil] Trigger [${activeTrigger.id}] hit at $${currentPrice}. Verifying route...`);

      const fromTicker = session.config.inputCurrency?.ticker || (session.mode === 'SNIPE' ? 'USDT' : 'XMR');
      const fromNetwork = session.config.inputCurrency?.network || (session.mode === 'SNIPE' ? 'ERC20' : 'Mainnet');
      const toTicker = session.config.outputCurrency?.ticker || (session.mode === 'SNIPE' ? 'XMR' : 'USDT');
      const toNetwork = session.config.outputCurrency?.network || (session.mode === 'SNIPE' ? 'Mainnet' : 'ERC20');

      const { kyc, log } = getPrivacyParams(session.config.compliance);
      const query = new URLSearchParams({
        from: fromTicker,
        from_net: fromNetwork,
        to: toTicker,
        to_net: toNetwork,
        amount: session.config.amount,
        kyc,
        log,
      });

      const baseUrl = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
      const url = `${baseUrl}/v2/exchange/estimate?${query.toString()}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`Estimate request failed: ${res.status}`);

      const data: EstimateResponse = await res.json();

      // Bail if triggers were cleared (abort happened while verifying)
      if (triggersRef.current.length === 0) {
        console.warn('[Vigil] Verification cancelled (engine stopped).');
        return;
      }

      // Re-check trigger against live price (slippage guard)
      let isConfirmed = false;
      if (activeTrigger.operator === '>=' && currentPrice >= activeTrigger.price) isConfirmed = true;
      if (activeTrigger.operator === '<=' && currentPrice <= activeTrigger.price) isConfirmed = true;

      if (!isConfirmed) {
        console.log(`[Vigil] Slippage prevented trigger [${activeTrigger.id}].`);
        return;
      }

      if (!data.routes || data.routes.length === 0) {
        console.warn('[Vigil] No routes available. Skipping execution.');
        return;
      }

      const bestRoute = data.routes.reduce((a, b) => (a.amount_to > b.amount_to ? a : b));
      console.log(`[Vigil] Route verified. Provider: ${bestRoute.provider}. Executing...`);

      // Fire the execution in the React state machine
      const payload: TriggerPayload = {
        provider: bestRoute.provider,
        engine: (bestRoute as any).engine || bestRoute.provider,
        eta: bestRoute.eta,
        amount_to: bestRoute.amount_to,
        krakenPrice: currentPrice,
        triggerId: activeTrigger.id,
        quote: bestRoute,
      };

      // Stop watching before executing
      triggersRef.current = [];
      closeWebSocket();

      executeStrike(payload);
    } catch (e: any) {
      console.error('[Vigil] Verification failed:', e);
    } finally {
      isVerifyingRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [API_BASE, closeWebSocket]);

  const checkTriggers = useCallback((currentPrice: number): VigilTrigger | null => {
    for (const trigger of triggersRef.current) {
      if (trigger.operator === '>=' && currentPrice >= trigger.price) return trigger;
      if (trigger.operator === '<=' && currentPrice <= trigger.price) return trigger;
    }
    return null;
  }, []);

  const connectWebSocket = useCallback((krakenPair: string) => {
    if (isConnectingRef.current) return;

    // Clean up any existing connection
    closeWebSocket();
    isConnectingRef.current = true;

    try {
      const ws = new WebSocket(KRAKEN_WS);

      ws.onopen = () => {
        console.log(`[Vigil] WS connected. Subscribing to ${krakenPair}...`);
        setWsConnected(true);
        isConnectingRef.current = false;

        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: [krakenPair],
          subscription: { name: 'trade' },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.event === 'heartbeat') return;
          if (data.event === 'systemStatus') return;

          if (data.event === 'subscriptionStatus') {
            if (data.status === 'error') {
              console.error(`[Vigil] Kraken subscription error: ${data.errorMessage}`);
              if (data.errorMessage?.includes('pair') || data.errorMessage?.includes('Currency')) {
                triggersRef.current = [];
                closeWebSocket();
              }
            }
            return;
          }

          // Trade data: [channelId, [[price, vol, time, side]], "trade", pair]
          if (Array.isArray(data) && data[2] === 'trade') {
            const trades = data[1];
            const latestTrade = trades[trades.length - 1];
            const currentPrice = parseFloat(latestTrade[0]);
            setPrice(currentPrice);

            const hit = checkTriggers(currentPrice);
            if (hit) {
              verifyAndExecute(currentPrice, hit);
            }
          }
        } catch (_) {
          // Ignore parse errors (heartbeat packets etc.)
        }
      };

      ws.onclose = (event) => {
        isConnectingRef.current = false;
        setWsConnected(false);

        // Only reconnect if we still have active triggers
        if (triggersRef.current.length > 0) {
          console.warn(`[Vigil] WS closed (code: ${event.code}). Reconnecting in 5s...`);
          retryTimeoutRef.current = setTimeout(() => {
            if (triggersRef.current.length > 0) connectWebSocket(krakenPair);
          }, 5000);
        }
      };

      ws.onerror = (err) => {
        console.error('[Vigil] WS error:', err);
        // onclose will fire after this, handling reconnect
      };

      wsRef.current = ws;
    } catch (e) {
      isConnectingRef.current = false;
      console.error('[Vigil] WS init failed:', e);
    }
  }, [closeWebSocket, checkTriggers, verifyAndExecute]);

  // ---------------------------------------------------------------------------
  // Start Watching
  // ---------------------------------------------------------------------------

  const startWatching = useCallback((session: VigilSession) => {
    const fromTicker = session.config.inputCurrency?.ticker || (session.mode === 'SNIPE' ? 'USDT' : 'XMR');
    const toTicker = session.config.outputCurrency?.ticker || (session.mode === 'SNIPE' ? 'XMR' : 'USDT');

    // Build triggers
    const triggers: VigilTrigger[] = [];
    const pMain = parseFloat(session.config.triggerPrice || '0');
    const pStop = parseFloat(session.config.stopPrice || '0');

    if (session.mode === 'SNIPE') {
      if (pMain > 0) triggers.push({ id: 'BUY_DIP', operator: '<=', price: pMain });
      if (pStop > 0) triggers.push({ id: 'BUY_BREAKOUT', operator: '>=', price: pStop });
    } else {
      if (pMain > 0) triggers.push({ id: 'TAKE_PROFIT', operator: '>=', price: pMain });
      if (pStop > 0) triggers.push({ id: 'STOP_LOSS', operator: '<=', price: pStop });
    }

    triggersRef.current = triggers;

    const krakenPair = getKrakenMonitoringPair(session.mode, fromTicker, toTicker);
    logger(`Vigil Armed. Mode: ${session.mode}. Pair: ${krakenPair}. Triggers: ${triggers.map(t => `${t.id} ${t.operator} $${t.price}`).join(' | ')}`);

    connectWebSocket(krakenPair);
  }, [connectWebSocket, logger]);

  // ---------------------------------------------------------------------------
  // Arm
  // ---------------------------------------------------------------------------

  const arm = useCallback(async (mode: 'SNIPE' | 'EJECT', config: VigilSession['config']) => {
    try {
      const session: VigilSession = { mode, config, state: 'WATCHING' };
      setActiveSession(session);
      setDepositInfo(null);
      setCompletedTrade(null);
      setProgress(0);
      setExecutionStatus('');
      setLogs([]);

      setState('WATCHING');
      logger(`Engine armed in ${mode} mode. Watching market...`, 'info');

      startWatching(session);
    } catch (e: any) {
      logger(`Arming failed: ${e.message}`, 'error');
      setState('ERROR');
    }
  }, [logger, startWatching]);

  // ---------------------------------------------------------------------------
  // Execute Strike
  // ---------------------------------------------------------------------------

  const executeStrike = useCallback(async (payload: TriggerPayload) => {
    if (stateRef.current === 'EXECUTING' || stateRef.current === 'TRIGGERED') return;

    const session = sessionRef.current;
    if (!session) return;

    setState('TRIGGERED');
    logger(`Target hit at $${payload.krakenPrice} [${payload.triggerId}]`, 'warn');

    // Brief delay for UI transition
    await new Promise(r => setTimeout(r, 500));
    setState('EXECUTING');
    logger('Executing strike...', 'process');

    try {
      const fromTicker = session.config.inputCurrency?.ticker || (session.mode === 'SNIPE' ? 'USDT' : 'XMR');
      const fromNetwork = session.config.inputCurrency?.network || (session.mode === 'SNIPE' ? 'ERC20' : 'Mainnet');
      const toTicker = session.config.outputCurrency?.ticker || (session.mode === 'SNIPE' ? 'XMR' : 'USDT');
      const toNetwork = session.config.outputCurrency?.network || (session.mode === 'SNIPE' ? 'Mainnet' : 'ERC20');

      const amount = parseFloat(session.config.amount);
      if (amount <= 0) throw new Error('Invalid amount');

      // For SNIPE: receive address is the vault's primary address
      // For EJECT: receive address is the user-provided target address
      const destinationAddress = session.config.targetAddress;

      logger('Creating swap order...', 'process');

      const trade = await createTrade({
        id: `vigil_${Date.now()}`,
        amountFrom: amount,
        amountTo: 0,
        fromTicker,
        fromNetwork,
        toTicker,
        toNetwork,
        destinationAddress,
        provider: payload.provider,
        source: 'ghost vigil sweep',
        fixed: false,
      });

      const depositAddress = trade.address_provider || trade.deposit_address;
      if (!depositAddress) throw new Error('Failed to get deposit address from provider');

      const tradeId = trade.trade_id || trade.id || '';
      logger(`Order created. ID: ${tradeId}`, 'success');

      if (session.mode === 'EJECT') {
        // ---------------------------------------------------------------
        // EJECT: Send XMR from vault to the exchange deposit address
        // ---------------------------------------------------------------
        logger('Sweeping XMR from vault...', 'process');

        let txHash: string | undefined;
        try {
          txHash = await vault.sendXmr(depositAddress, amount);
        } catch (sendErr: any) {
          // If sendXmr fails, try sweep_all via IPC as fallback
          logger(`sendXmr failed (${sendErr.message}), attempting sweep_all...`, 'warn');
          const sweepResult = await window.api.walletAction('mnemonic' as any, {});
          // The actual sweep is done through proxyRequest for sweep_all
          const rpcResult = await window.api.proxyRequest({
            method: 'sweep_all',
            params: { address: depositAddress },
          });
          if (!rpcResult.success) throw new Error(rpcResult.error || 'sweep_all failed');
          txHash = rpcResult.result?.tx_hash_list?.[0] || 'sweep_submitted';
        }

        logger(`TX Broadcasted: ${txHash || 'pending'}`, 'success');

        setCompletedTrade({
          id: tradeId,
          amount: amount.toString(),
          txHash,
          inputCurrency: session.config.inputCurrency,
          outputCurrency: session.config.outputCurrency,
        });

        setState('COMPLETED');
        setActiveSession(null);

      } else {
        // ---------------------------------------------------------------
        // SNIPE: Show deposit info for user to fund externally
        // ---------------------------------------------------------------
        const depositMemo = (trade as any).address_provider_memo;
        setDepositInfo({
          address: depositAddress,
          amount: trade.deposit_amount || amount,
          ticker: fromTicker,
          memo: depositMemo,
        });

        setCompletedTrade({
          id: tradeId,
          amount: amount.toString(),
          inputCurrency: session.config.inputCurrency,
          outputCurrency: session.config.outputCurrency,
        });

        logger(`Deposit ${trade.deposit_amount || amount} ${fromTicker} to: ${depositAddress}${depositMemo ? ` (memo: ${depositMemo})` : ''}`, 'success');
        setState('COMPLETED');
        setActiveSession(null);
      }
    } catch (e: any) {
      logger(`Execution failed: ${e.message}`, 'error');
      // On failure, return to WATCHING so user can retry or abort
      setState('ERROR');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logger, vault.sendXmr]);

  // ---------------------------------------------------------------------------
  // Abort
  // ---------------------------------------------------------------------------

  const abort = useCallback(() => {
    logger('Aborting vigil...', 'warn');
    triggersRef.current = [];
    closeWebSocket();
    setActiveSession(null);
    setState('IDLE');
    setDepositInfo(null);
    setExecutionStatus('');
    setProgress(0);
    logger('Vigil disarmed.', 'info');
  }, [closeWebSocket, logger]);

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    triggersRef.current = [];
    closeWebSocket();
    setActiveSession(null);
    setState('IDLE');
    setLogs([]);
    setExecutionStatus('');
    setProgress(0);
    setCompletedTrade(null);
    setDepositInfo(null);
    setPrice(null);
    setWsConnected(false);
  }, [closeWebSocket]);

  // ---------------------------------------------------------------------------
  // Cleanup on unmount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    return () => {
      triggersRef.current = [];
      closeWebSocket();
    };
  }, [closeWebSocket]);

  // ---------------------------------------------------------------------------
  // Derived price: prefer live WS price, fallback to fiat API
  // ---------------------------------------------------------------------------

  const finalPrice = price ?? (parseFloat(fiatPrice || '0') || null);

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    state,
    logs,
    executionStatus,
    progress,
    arm,
    abort,
    price: finalPrice,
    reset,
    wsConnected,
    activeSession,
    completedTrade,
    depositInfo,
  };
}
