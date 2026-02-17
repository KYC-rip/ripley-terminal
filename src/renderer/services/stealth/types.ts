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
  SYNCING: 'SYNCING',
  DISPERSING: 'DISPERSING',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR'
} as const;

export type StealthStep = typeof StealthStep[keyof typeof StealthStep];


export interface IStealthEngine {
 
}

export interface StealthConfig {
  minDelay: number;
  maxDelay: number;
  rpcUrl: string;
}

export interface StealthOrder {
  quote: BatchQuoteResult;
  destAddress: string;
}

export type StealthLogger = (msg: string, type?: 'info' | 'success' | 'warning' | 'process' | 'error') => void;

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
