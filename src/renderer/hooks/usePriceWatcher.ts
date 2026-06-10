import { useState, useRef, useCallback, useEffect } from 'react';

/**
 * Kraken trade-feed price watcher with trigger evaluation.
 *
 * Owns the WebSocket lifecycle: reconnects with exponential backoff
 * (5s -> 60s); after MAX_CONSECUTIVE_FAILURES it stops retrying and surfaces
 * `degraded: true` so the UI can show a stale-feed banner with a manual
 * reconnect — armed triggers are kept, never silently dropped.
 *
 * The WS rides the app-wide session proxy (Tor when enabled), like all
 * renderer network traffic.
 */

export interface PriceTrigger {
  id: string;
  operator: '>=' | '<=';
  price: number;
}

export function evaluateTriggers(triggers: PriceTrigger[], price: number): PriceTrigger | null {
  for (const trigger of triggers) {
    if (trigger.operator === '>=' && price >= trigger.price) return trigger;
    if (trigger.operator === '<=' && price <= trigger.price) return trigger;
  }
  return null;
}

const KRAKEN_WS = 'wss://ws.kraken.com';
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_CONSECUTIVE_FAILURES = 5;

export function usePriceWatcher(onTrigger: (price: number, trigger: PriceTrigger) => void) {
  const [price, setPrice] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [lastTickAt, setLastTickAt] = useState<number | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggersRef = useRef<PriceTrigger[]>([]);
  const pairRef = useRef<string>('');
  const failuresRef = useRef(0);
  const connectingRef = useRef(false);
  const onTriggerRef = useRef(onTrigger);
  useEffect(() => { onTriggerRef.current = onTrigger; }, [onTrigger]);

  const closeSocket = useCallback(() => {
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      try { wsRef.current.close(); } catch { /* noop */ }
      wsRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  const connect = useCallback((krakenPair: string) => {
    if (connectingRef.current) return;
    closeSocket();
    connectingRef.current = true;
    pairRef.current = krakenPair;

    try {
      const ws = new WebSocket(KRAKEN_WS);

      ws.onopen = () => {
        connectingRef.current = false;
        failuresRef.current = 0;
        setConnected(true);
        setDegraded(false);
        ws.send(JSON.stringify({
          event: 'subscribe',
          pair: [krakenPair],
          subscription: { name: 'trade' },
        }));
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.event === 'heartbeat' || data.event === 'systemStatus') return;

          if (data.event === 'subscriptionStatus') {
            if (data.status === 'error') {
              console.error(`[PriceWatcher] Kraken subscription error: ${data.errorMessage}`);
              // Unknown pair: retrying won't help, stop and surface degraded
              if (data.errorMessage?.includes('pair') || data.errorMessage?.includes('Currency')) {
                closeSocket();
                setConnected(false);
                setDegraded(true);
              }
            }
            return;
          }

          // Trade data: [channelId, [[price, vol, time, side]], "trade", pair]
          if (Array.isArray(data) && data[2] === 'trade') {
            const trades = data[1];
            const latest = trades[trades.length - 1];
            const currentPrice = parseFloat(latest[0]);
            setPrice(currentPrice);
            setLastTickAt(Date.now());

            const hit = evaluateTriggers(triggersRef.current, currentPrice);
            if (hit) onTriggerRef.current(currentPrice, hit);
          }
        } catch { /* ignore malformed packets */ }
      };

      ws.onclose = (event) => {
        connectingRef.current = false;
        setConnected(false);

        if (triggersRef.current.length === 0) return; // nothing armed, stay quiet

        failuresRef.current += 1;
        if (failuresRef.current >= MAX_CONSECUTIVE_FAILURES) {
          console.warn(`[PriceWatcher] WS failed ${failuresRef.current}x — entering degraded mode (manual reconnect required).`);
          setDegraded(true);
          return;
        }

        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failuresRef.current - 1), BACKOFF_MAX_MS);
        console.warn(`[PriceWatcher] WS closed (code ${event.code}). Reconnecting in ${delay / 1000}s...`);
        retryTimeoutRef.current = setTimeout(() => {
          if (triggersRef.current.length > 0) connect(krakenPair);
        }, delay);
      };

      ws.onerror = () => { /* onclose fires next and handles retry */ };

      wsRef.current = ws;
    } catch (e) {
      connectingRef.current = false;
      console.error('[PriceWatcher] WS init failed:', e);
    }
  }, [closeSocket]);

  /** Arm triggers and start (or retarget) the feed. */
  const watch = useCallback((krakenPair: string, triggers: PriceTrigger[]) => {
    triggersRef.current = triggers;
    failuresRef.current = 0;
    setDegraded(false);
    connect(krakenPair);
  }, [connect]);

  /** Manual reconnect from the degraded-state banner. */
  const reconnect = useCallback(() => {
    failuresRef.current = 0;
    setDegraded(false);
    if (pairRef.current) connect(pairRef.current);
  }, [connect]);

  /** Disarm and close the feed. */
  const stop = useCallback(() => {
    triggersRef.current = [];
    closeSocket();
    setConnected(false);
    setDegraded(false);
  }, [closeSocket]);

  useEffect(() => () => { triggersRef.current = []; closeSocket(); }, [closeSocket]);

  return { price, connected, degraded, lastTickAt, watch, reconnect, stop, hasTriggers: () => triggersRef.current.length > 0, clearTriggers: () => { triggersRef.current = []; } };
}

/**
 * Derives the Kraken monitoring pair from swap currencies.
 * e.g. SNIPE USDT->XMR => "XMR/USD", EJECT XMR->USDT => "XMR/USD"
 */
export function getKrakenMonitoringPair(mode: 'SNIPE' | 'EJECT', from: string, to: string): string {
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
}
