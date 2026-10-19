import { describe, expect, it } from 'vitest';
import {
  birthdayToDateInput, countVerdict, formatMonthYear, normalizePhrase, phraseWordCount,
  parseHeight, planAuthSubmit, prettyLanguage, seedVerdict, shouldInspect, validateViewOnlyForm,
} from './seedVerdict';

const ADDR = '4' + 'A'.repeat(94);
const MAR_2024 = Date.UTC(2024, 2, 1) / 1000;

describe('seedVerdict', () => {
  it('polyseed: birthday month, no date needed, address line', () => {
    const v = seedVerdict({ format: 'polyseed', language: 'English', birthdayUnix: MAR_2024, primaryAddress: ADDR, network: 'mainnet' });
    expect(v.tone).toBe('ok');
    expect(v.text).toBe('POLYSEED (Feather / Cake) · created around Mar 2024 — no date needed');
    expect(v.addressLine).toBe(`Opens ${ADDR} on MAINNET — check it matches your old wallet's address.`);
  });

  it('legacy 25 / 24 name the language', () => {
    expect(seedVerdict({ format: 'legacy25', language: 'English', primaryAddress: ADDR, network: 'mainnet' }).text).toBe('25-WORD MONERO SEED (English)');
    expect(seedVerdict({ format: 'legacy24', language: 'ChineseSimplified', primaryAddress: ADDR, network: 'stagenet' }).text).toBe('24-WORD MONERO SEED (Chinese Simplified)');
    expect(seedVerdict({ format: 'legacy25', language: 'English', primaryAddress: ADDR, network: 'stagenet' }).addressLine).toContain('on STAGENET');
  });

  it('a failure shows the backend error and no address', () => {
    const v = seedVerdict({ format: 'feather14', error: 'A 14-word seed is from Feather before 2.0 — not supported yet.' });
    expect(v).toEqual({ tone: 'warn', text: 'A 14-word seed is from Feather before 2.0 — not supported yet.' });
    expect(seedVerdict({ format: 'legacy25', error: 'Invalid mnemonic: bad checksum' })).toEqual({ tone: 'error', text: 'Invalid mnemonic: bad checksum' });
    expect(seedVerdict({ format: 'mymonero13', error: 'x' }).tone).toBe('warn');
    expect(seedVerdict({ format: 'bip39_like', error: 'y' }).tone).toBe('warn');
  });

  it('an error wins even if an address came back; a missing error still says something', () => {
    expect(seedVerdict({ format: 'legacy25', primaryAddress: ADDR, error: 'boom' }).addressLine).toBeUndefined();
    expect(seedVerdict({ format: 'unknown' }).text).toMatch(/not a seed format/i);
  });
});

describe('phrase helpers', () => {
  it('normalises whitespace and counts words', () => {
    expect(normalizePhrase('  a \n b\t c  ')).toBe('a b c');
    expect(phraseWordCount('')).toBe(0);
    expect(phraseWordCount('  a  b ')).toBe(2);
  });
  it('inspects only counts some format uses', () => {
    for (const n of [12, 13, 14, 16, 24, 25]) expect(shouldInspect(n)).toBe(true);
    for (const n of [0, 1, 11, 17, 23, 26]) expect(shouldInspect(n)).toBe(false);
  });
  it('count verdict', () => {
    expect(countVerdict(0)).toBeNull();
    expect(countVerdict(7)?.text).toBe('7 words — not a seed format Ripley knows (25, 24 or 16 words)');
    expect(countVerdict(1)?.text).toMatch(/^1 word —/);
  });
  it('dates are UTC', () => {
    expect(formatMonthYear(MAR_2024)).toBe('Mar 2024');
    expect(birthdayToDateInput(MAR_2024)).toBe('2024-03-01');
    expect(prettyLanguage('ChineseTraditional')).toBe('Chinese Traditional');
    expect(prettyLanguage(undefined)).toBe('');
  });
});

describe('validateViewOnlyForm', () => {
  const ok = { name: 'Old', address: ADDR, viewKey: 'a'.repeat(64), password: 'password1', confirmPassword: 'password1' };
  it('accepts a well-formed form', () => { expect(validateViewOnlyForm(ok)).toBeNull(); });
  it('refuses each bad field', () => {
    expect(validateViewOnlyForm({ ...ok, name: ' ' })).toBe('WALLET_NAME_REQUIRED');
    expect(validateViewOnlyForm({ ...ok, address: '' })).toBe('PRIMARY_ADDRESS_REQUIRED');
    expect(validateViewOnlyForm({ ...ok, address: '4' + '0'.repeat(94) })).toMatch(/^ADDRESS_INVALID/);
    expect(validateViewOnlyForm({ ...ok, address: '4' + 'A'.repeat(105) })).toMatch(/^INTEGRATED_ADDRESS/);
    expect(validateViewOnlyForm({ ...ok, address: '4AAA' })).toMatch(/95 CHARACTERS/);
    expect(validateViewOnlyForm({ ...ok, address: '8' + 'A'.repeat(94) })).toMatch(/^SUBADDRESS/);
    expect(validateViewOnlyForm({ ...ok, viewKey: 'zz' })).toMatch(/^VIEW_KEY_INVALID/);
    expect(validateViewOnlyForm({ ...ok, password: 'short', confirmPassword: 'short' })).toBe('SECRET_TOO_SHORT: MIN 8 CHARS');
    expect(validateViewOnlyForm({ ...ok, confirmPassword: 'password2' })).toBe('PASSWORDS_DO_NOT_MATCH');
  });
});

describe('planAuthSubmit (the restore / create form submit)', () => {
  const base = {
    step: 'RESTORE', restoreMode: 'phrase' as const, isInitialSetup: true, canImportViewOnly: true,
    password: 'hunter2hunter2', confirmPassword: 'hunter2hunter2', newName: 'Main',
    restoreSeed: '', restoreHeight: '', seedLanguage: 'English', viewAddress: '', viewKey: '',
  };
  const KEY = 'ab'.repeat(32);

  it('restore: normalised phrase, height and language reach unlock', () => {
    expect(planAuthSubmit({ ...base, restoreSeed: '  unaware  yard\ndonate ', restoreHeight: '3100000' })).toEqual({
      kind: 'unlock', password: base.password, name: 'Main', seed: 'unaware yard donate', height: 3100000, seedLanguage: 'English',
    });
  });

  it('restore with an empty phrase is refused — it used to create a NEW wallet', () => {
    expect(planAuthSubmit({ ...base, restoreSeed: '   ' })).toEqual({ kind: 'error', error: 'RECOVERY_PHRASE_REQUIRED' });
  });

  it('a garbled height is refused, an empty one means no height', () => {
    expect(planAuthSubmit({ ...base, restoreSeed: 'a b', restoreHeight: '12abc' }).kind).toBe('error');
    expect(planAuthSubmit({ ...base, restoreSeed: 'a b', restoreHeight: '-5' }).kind).toBe('error');
    expect(planAuthSubmit({ ...base, restoreSeed: 'a b', restoreHeight: ' ' })).toMatchObject({ kind: 'unlock', height: undefined });
    expect(parseHeight('0')).toBe(0);
    expect(parseHeight('9'.repeat(400))).toBeUndefined();   // Infinity / unsafe, never forwarded
  });

  it('password rules apply to restore and create, not to unlocking', () => {
    expect(planAuthSubmit({ ...base, restoreSeed: 'a', password: 'short', confirmPassword: 'short' })).toEqual({ kind: 'error', error: 'SECRET_TOO_SHORT: MIN 8 CHARS' });
    expect(planAuthSubmit({ ...base, step: 'NEW_PASSWORD', confirmPassword: 'different1' })).toEqual({ kind: 'error', error: 'PASSWORDS_DO_NOT_MATCH' });
    expect(planAuthSubmit({ ...base, step: 'AUTH', password: 'x', confirmPassword: '', newName: '' })).toEqual({
      kind: 'unlock', password: 'x', name: undefined, seed: undefined, height: undefined, seedLanguage: undefined,
    });
  });

  it('create (NEW_PASSWORD) sends no seed even if the restore box had text', () => {
    expect(planAuthSubmit({ ...base, step: 'NEW_PASSWORD', restoreSeed: 'left over' })).toMatchObject({ kind: 'unlock', seed: undefined, seedLanguage: undefined });
  });

  it('view-only: trimmed fields reach the import; checks run first', () => {
    expect(planAuthSubmit({ ...base, restoreMode: 'viewonly', viewAddress: ` ${ADDR} `, viewKey: ` ${KEY} `, restoreHeight: '3000000' })).toEqual({
      kind: 'viewOnly', name: 'Main', password: base.password, address: ADDR, viewKey: KEY, height: 3000000,
    });
    expect(planAuthSubmit({ ...base, restoreMode: 'viewonly', viewAddress: ADDR, viewKey: 'zz' })).toEqual({ kind: 'error', error: 'VIEW_KEY_INVALID: 64 HEX CHARACTERS' });
    expect(planAuthSubmit({ ...base, restoreMode: 'viewonly', canImportViewOnly: false })).toEqual({ kind: 'error', error: 'VIEW_ONLY_IMPORT_UNAVAILABLE' });
  });

  it('AUTH never forwards a leftover name (unlock would CREATE a wallet) or height', () => {
    expect(planAuthSubmit({ ...base, step: 'AUTH', newName: 'Typed earlier', restoreHeight: '12abc', confirmPassword: '' })).toEqual({
      kind: 'unlock', password: base.password, name: undefined, seed: undefined, height: undefined, seedLanguage: undefined,
    });
  });

  it('create (NEW_PASSWORD) keeps its name but ignores a leftover height, valid or not', () => {
    expect(planAuthSubmit({ ...base, step: 'NEW_PASSWORD', restoreHeight: '3100000' })).toMatchObject({ kind: 'unlock', name: 'Main', height: undefined });
    expect(planAuthSubmit({ ...base, step: 'NEW_PASSWORD', restoreHeight: '-5' })).toMatchObject({ kind: 'unlock', height: undefined });
  });

  it('view-only mode outside RESTORE is an ordinary unlock', () => {
    expect(planAuthSubmit({ ...base, step: 'AUTH', restoreMode: 'viewonly' }).kind).toBe('unlock');
  });
});

describe('alsoBip39 verdict', () => {
  it('warns but still shows the address to compare', () => {
    const v = seedVerdict({ format: 'legacy24', language: 'English', primaryAddress: ADDR, network: 'mainnet', alsoBip39: true });
    expect(v.tone).toBe('warn');
    expect(v.text).toMatch(/ALSO A BIP39 PHRASE/);
    expect(v.addressLine).toContain(ADDR);
  });
});
