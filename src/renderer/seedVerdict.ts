// Pure helpers for the restore screen (onboarding P1, plans/onboarding-p1-plan.md §B/§C in ripley-os):
// the one-line verdict under the phrase box (from the native `inspect_seed` result) and the
// view-only form's validation. No React, no bridge — tested in seedVerdict.test.ts.

/** What `inspect_seed` returns. Public data only — never key material. */
export interface SeedInspection {
  format: 'legacy25' | 'legacy24' | 'polyseed' | 'bip39_like' | 'feather14' | 'mymonero13' | 'unknown';
  language?: string | null;
  birthdayUnix?: number | null;
  primaryAddress?: string | null;
  network?: string | null;
  /** 24 words that are ALSO a valid BIP39 phrase (~1e-9 by chance; a built phrase can be both). */
  alsoBip39?: boolean | null;
  error?: string | null;
}

export interface SeedVerdict {
  tone: 'ok' | 'warn' | 'error' | 'muted';
  /** The one-line verdict. */
  text: string;
  /** "Opens <address> on <network> — …", only when the phrase is importable. */
  addressLine?: string;
}

/** Word counts some known format uses — only these are worth a (PBKDF2-heavy) native inspect. */
const KNOWN_COUNTS = new Set([12, 13, 14, 15, 16, 18, 21, 24, 25]);

export function normalizePhrase(phrase: string): string {
  return phrase.trim().split(/\s+/).filter(Boolean).join(' ');
}

export function phraseWordCount(phrase: string): number {
  const n = normalizePhrase(phrase);
  return n ? n.split(' ').length : 0;
}

export function shouldInspect(wordCount: number): boolean {
  return KNOWN_COUNTS.has(wordCount);
}

/** Verdict for a word count no format uses (no native call made). Null for an empty box. */
export function countVerdict(wordCount: number): SeedVerdict | null {
  if (wordCount === 0) return null;
  return {
    tone: 'muted',
    text: `${wordCount} word${wordCount === 1 ? '' : 's'} — not a seed format Ripley knows (25, 24 or 16 words)`,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mar 2024" (UTC — Polyseed birthdays are floored to ~1-month steps, so the day is meaningless). */
export function formatMonthYear(unix: number): string {
  const d = new Date(unix * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Unix seconds → the `<input type="date">` value ("YYYY-MM-DD", UTC). */
export function birthdayToDateInput(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

/** "ChineseSimplified" → "Chinese Simplified" (the backend sends the Rust enum's Debug name). */
export function prettyLanguage(lang: string | null | undefined): string {
  return (lang || '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

export function seedVerdict(r: SeedInspection): SeedVerdict {
  const importable = !r.error && !!r.primaryAddress;
  const addressLine = importable
    ? `Opens ${r.primaryAddress} on ${(r.network || 'mainnet').toUpperCase()} — check it matches your old wallet's address.`
    : undefined;
  const lang = prettyLanguage(r.language);
  if (importable) {
    switch (r.format) {
      case 'polyseed':
        return {
          tone: 'ok',
          text: r.birthdayUnix
            ? `POLYSEED (Feather / Cake) · created around ${formatMonthYear(r.birthdayUnix)} — no date needed`
            : 'POLYSEED (Feather / Cake)',
          addressLine,
        };
      case 'legacy25':
        return { tone: 'ok', text: `25-WORD MONERO SEED${lang ? ` (${lang})` : ''}`, addressLine };
      case 'legacy24':
        if (r.alsoBip39) {
          // Both formats at once: a BIP39 phrase (Cake BIP39, Ledger, MetaMask…) read as Monero
          // opens a different, empty wallet. The address line is how the user tells which.
          return {
            tone: 'warn',
            text: 'THESE 24 WORDS ARE ALSO A BIP39 PHRASE — if they came from Cake (BIP39), Ledger, Trezor or MetaMask they will NOT open your Monero funds',
            addressLine,
          };
        }
        return { tone: 'ok', text: `24-WORD MONERO SEED${lang ? ` (${lang})` : ''}`, addressLine };
      default:
        // An importable result in a format the UI has no copy for: still say what it opens.
        return { tone: 'ok', text: 'MONERO SEED', addressLine };
    }
  }
  // Not importable: the backend's own explanation is the verdict.
  const recognised = r.format === 'feather14' || r.format === 'mymonero13' || r.format === 'bip39_like';
  return {
    tone: recognised ? 'warn' : 'error',
    text: r.error || 'Not a seed format Ripley knows (25, 24 or 16 words)',
  };
}

export interface ViewOnlyForm {
  name: string;
  address: string;
  viewKey: string;
  password: string;
  confirmPassword: string;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Cheap shape checks before the native import (which is authoritative: network, primary-vs-sub,
 *  view-key-belongs-to-address). Returns the first problem in AuthView's error style, or null. */
export function validateViewOnlyForm(f: ViewOnlyForm): string | null {
  if (!f.name.trim()) return 'WALLET_NAME_REQUIRED';
  const address = f.address.trim();
  if (!address) return 'PRIMARY_ADDRESS_REQUIRED';
  if (!BASE58.test(address)) return 'ADDRESS_INVALID: NOT A MONERO ADDRESS';
  if (address.length === 106) return 'INTEGRATED_ADDRESS: USE THE WALLET\'S PRIMARY ADDRESS';
  if (address.length !== 95) return 'ADDRESS_INVALID: A PRIMARY ADDRESS IS 95 CHARACTERS';
  if (/^[78B]/.test(address)) return 'SUBADDRESS: USE THE WALLET\'S PRIMARY ADDRESS';
  if (!/^[0-9a-fA-F]{64}$/.test(f.viewKey.trim())) return 'VIEW_KEY_INVALID: 64 HEX CHARACTERS';
  if (f.password.length < 8) return 'SECRET_TOO_SHORT: MIN 8 CHARS';
  if (f.password !== f.confirmPassword) return 'PASSWORDS_DO_NOT_MATCH';
  return null;
}

/** What the restore/create form's submit does, decided from its fields (AuthView.handleUnlockSubmit). */
export type AuthSubmitPlan =
  | { kind: 'error'; error: string }
  | { kind: 'viewOnly'; name: string; password: string; address: string; viewKey: string; height?: number }
  | { kind: 'unlock'; password: string; name?: string; seed?: string; height?: number; seedLanguage?: string };

export interface AuthSubmitFields {
  step: string;
  restoreMode: 'phrase' | 'viewonly';
  isInitialSetup: boolean;
  canImportViewOnly: boolean;
  password: string;
  confirmPassword: string;
  newName: string;
  restoreSeed: string;
  restoreHeight: string;
  seedLanguage: string;
  viewAddress: string;
  viewKey: string;
}

/** A height field value → a block height, or undefined (empty / not a whole non-negative number). */
export function parseHeight(raw: string): number | undefined {
  const t = raw.trim();
  const n = /^\d+$/.test(t) ? Number(t) : NaN;
  return Number.isSafeInteger(n) ? n : undefined;
}

export function planAuthSubmit(f: AuthSubmitFields): AuthSubmitPlan {
  const viewOnly = f.step === 'RESTORE' && f.restoreMode === 'viewonly';
  if (viewOnly) {
    const problem = !f.canImportViewOnly
      ? 'VIEW_ONLY_IMPORT_UNAVAILABLE'
      : validateViewOnlyForm({ name: f.newName, address: f.viewAddress, viewKey: f.viewKey, password: f.password, confirmPassword: f.confirmPassword });
    if (problem) return { kind: 'error', error: problem };
  }
  if (f.step === 'RESTORE' || f.step === 'NEW_PASSWORD' || (f.step === 'LABEL' && f.isInitialSetup)) {
    if (f.password.length < 8) return { kind: 'error', error: 'SECRET_TOO_SHORT: MIN 8 CHARS' };
    if (f.password !== f.confirmPassword) return { kind: 'error', error: 'PASSWORDS_DO_NOT_MATCH' };
  }
  const restoring = f.step === 'RESTORE';
  // Name and height belong to the step that uses them. A name typed in create/restore and left
  // in state must not reach an AUTH unlock — VaultContext.unlock treats ANY name as "create a
  // wallet". A height only means something when restoring.
  const creating = restoring || f.step === 'NEW_PASSWORD';
  // An empty phrase box on RESTORE used to reach unlock() with seed '' — which CREATES a new
  // wallet. Restoring without a phrase is never what the user meant.
  if (restoring && !viewOnly && !normalizePhrase(f.restoreSeed)) return { kind: 'error', error: 'RECOVERY_PHRASE_REQUIRED' };
  const height = restoring ? parseHeight(f.restoreHeight) : undefined;
  // A garbled height must not silently become "scan from 2017".
  if (restoring && f.restoreHeight.trim() && height === undefined) return { kind: 'error', error: 'RESTORE_HEIGHT_INVALID: A WHOLE BLOCK NUMBER' };
  if (viewOnly) {
    return { kind: 'viewOnly', name: f.newName.trim(), password: f.password, address: f.viewAddress.trim(), viewKey: f.viewKey.trim(), height };
  }
  return {
    kind: 'unlock',
    password: f.password,
    name: creating ? f.newName || undefined : undefined,
    seed: restoring ? normalizePhrase(f.restoreSeed) : undefined,
    height,
    seedLanguage: restoring ? f.seedLanguage : undefined,
  };
}
