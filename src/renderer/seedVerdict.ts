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
