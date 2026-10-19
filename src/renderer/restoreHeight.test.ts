// VECTOR TABLE MIRRORED from ripley-os src/os/wallet/restoreHeight.test.ts (this file tests the classic
// renderer's TS port of that estimator). The two copies must stay identical: a change to the estimator in one repo
// needs the same vector change in the other. Honest limit: this only catches drift in a repo whose own
// vectors were updated — there is no cross-repo check yet (P1).
import { describe, expect, it } from 'vitest';
import { moneroFreshWalletHeight, moneroRestoreHeightFromDate } from './restoreHeight';

const ANCHOR_NOW = Date.UTC(2026, 9, 13, 22, 40);   // the anchor's own moment: tip 3,783,210 (mainnet)
const DAY = 86_400_000;

// [label, date, tip, now, network, expected height]
const RESTORE_VECTORS: Array<[string, string, number | null, number, string | undefined, number | null]> = [
  ['live tip, one week early', '2026-07-25', 3_500_000, Date.UTC(2026, 7, 1), undefined, 3_489_920],
  ['live tip on stagenet is used as-is', '2026-07-25', 1_900_000, Date.UTC(2026, 7, 1), 'stagenet', 1_889_920],
  ['one-minute era → genesis', '2015-01-01', 3_500_000, Date.UTC(2026, 7, 1), undefined, 0],
  ['one-minute era → genesis even with no tip off mainnet', '2015-01-01', null, Date.UTC(2026, 7, 1), 'stagenet', 0],
  ['invalid date', 'nope', 3_500_000, Date.UTC(2026, 7, 1), undefined, null],
  ['future date', '2027-01-01', 3_500_000, Date.UTC(2026, 7, 1), undefined, null],
  ['no tip, mainnet: anchor (clock behind the anchor holds at it)', '2026-07-25', 0, Date.UTC(2026, 7, 1), undefined, 3_783_210 - 5_040 - 5_040],
  ['no tip, explicit mainnet: anchor + 10 days', '2026-10-01', 0, ANCHOR_NOW + 10 * DAY, 'mainnet', 3_783_210 + 7_200 - 16_520 - 5_040],
  ['no tip, stagenet: no estimate', '2025-01-01', 0, Date.UTC(2026, 7, 1), 'stagenet', null],
  ['no tip, testnet: no estimate', '2025-01-01', null, Date.UTC(2026, 7, 1), 'testnet', null],
];

describe('moneroRestoreHeightFromDate', () => {
  for (const [label, date, tip, now, network, expected] of RESTORE_VECTORS) {
    it(label, () => { expect(moneroRestoreHeightFromDate(date, tip, now, network)).toBe(expected); });
  }
});

// [label, tip, now, network, expected height]
const FRESH_VECTORS: Array<[string, number | null | undefined, number, string | undefined, number | undefined]> = [
  ['a day below the live tip', 3_800_000, ANCHOR_NOW, undefined, 3_800_000 - 720],
  ['never below genesis', 100, ANCHOR_NOW, undefined, 0],
  ['no tip, mainnet: anchor - day - week', null, ANCHOR_NOW, undefined, 3_783_210 - 720 - 7 * 720],
  ['no tip, mainnet, ten days later: +7200 blocks', 0, ANCHOR_NOW + 10 * DAY, 'mainnet', 3_783_210 + 10 * 720 - 720 - 7 * 720],
  ['no tip, clock behind the anchor never goes below it', undefined, ANCHOR_NOW - DAY, undefined, 3_783_210 - 720 - 7 * 720],
  ['live tip on stagenet', 1_900_000, ANCHOR_NOW, 'stagenet', 1_900_000 - 720],
  ['no tip, stagenet: undefined (caller relies on fresh: true)', 0, ANCHOR_NOW, 'stagenet', undefined],
];

describe('moneroFreshWalletHeight', () => {
  for (const [label, tip, now, network, expected] of FRESH_VECTORS) {
    it(label, () => { expect(moneroFreshWalletHeight(tip, now, network)).toBe(expected); });
  }
});
