import { useVault as useGlobalVault } from '../contexts/VaultContext';

/**
 * Tactical Bridge to Global Vault Context.
 * Ensures all components share the same wallet engine instance.
 */
export function useVault() {
  return useGlobalVault();
}
