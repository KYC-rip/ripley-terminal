/**
 * Module-level mirror of "an EJECT vigil is armed, keep the Monero spend key
 * resident through a UI lock so the order can dispatch unattended". True only
 * while an EJECT vigil is armed/executing. Never persisted; dies with the
 * process.
 *
 * Tauri adaptation: unlike Electron (where VaultContext.lock() reads this JS
 * flag and skips closing wallet-rpc), the Tauri soft-lock runs in Rust and is
 * the single source of truth. So the setter also mirrors the flag into the
 * Rust backend via the `set_vigil_hot` command — state.lock() retains the
 * spend key iff that flag is set. The invoke is fire-and-forget (don't block
 * the hot-wallet effect on IPC latency).
 */
import { invoke } from '@tauri-apps/api/core';

let keepOpen = false;

export function setVigilKeepsWalletOpen(v: boolean) {
  keepOpen = v;
  // Mirror to the Rust backend so state.lock() retains the spend key while
  // an EJECT vigil is armed. Fire-and-forget.
  invoke('set_vigil_hot', { hot: v }).catch((e) => {
    console.warn('[Vigil] set_vigil_hot failed:', e);
  });
}

export function vigilKeepsWalletOpen(): boolean {
  return keepOpen;
}
