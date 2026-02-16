import { type BatchQuoteResult } from '../swap';

/**
 * Stealth Sequence Lifecycle Steps
 */
export const StealthStep = {
  IDLE: 'IDLE',
  INITIALIZING: 'INITIALIZING',
  AWAITING_FUNDS: 'AWAITING_FUNDS',
  PRE_SPLITTING: 'PRE_SPLITTING',
  AWAITING_UNLOCK: 'AWAITING_UNLOCK',
  DISPERSING: 'DISPERSING',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR'
} as const;

export type StealthStep = typeof StealthStep[keyof typeof StealthStep];

export interface StealthConfig {
  minDelay: number;
  maxDelay: number;
  rpcUrl: string;
}

export interface StealthOrder {
  quote: BatchQuoteResult;
  destAddress: string;
}

export type StealthLogger = (msg: string, type?: 'info' | 'success' | 'warn' | 'process' | 'error') => void;

export interface IncomingTxStatus {
  hash: string;              // Tx Hash
  confirmations: number;     // Confirmations
  required: number;          // Required confirmations
  isMempool: boolean;        // Whether still in mempool (0 confirmations)
}

export type InitResult = string | { 
  address: string; 
  restoreHeight: number; 
};

/**
 * Common interface for all Stealth Execution Engines
 */
export interface IStealthEngine {
  init(
    rpcUrl: string,
    secret?: string,
    subIndex?: number,
    height?: number
  ): Promise<InitResult>
  getAddress(): string;
  getPrivateKey(): string;
  getBalance(): Promise<{ total: string, unlocked: string }>;
  getIncomingTxStatus(): Promise<IncomingTxStatus | null>;

  // Execution
  start(
    orders: StealthOrder[],
    config: StealthConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onOrderCreated?: (idx: number, trade: any) => void
  ): Promise<void>;

  stop(): void;
  sweep(toAddress: string): Promise<string>;

  // State helpers
  getStep(): StealthStep;
}