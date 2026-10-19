// PORT of ripley-os src/os/wallet/restoreHeight.ts (the classic renderer cannot import it). Keep the
// two identical; restoreHeight.test.ts here mirrors that repo's vector table.
const BLOCK_MS = 120_000;
const SAFETY_BLOCKS = 7 * 720; // start one week early; extra scanning is safe
const TWO_MINUTE_ERA = Date.UTC(2016, 3, 1);

/** A chain anchor for when no node has answered yet (first wallet on a fresh install): height
 *  3,783,210 was the MAINNET tip on 2026-10-13 ~22:40 UTC. Monero averages one block per two
 *  minutes, so the tip at `now` is anchor + elapsed / 2 min — accurate to well under a day across
 *  years. It is a mainnet height: on stagenet/testnet it lands ~1.8M blocks ABOVE the real tip,
 *  and a wallet told to start there idles as "synced" forever — so it is never used off mainnet. */
const ANCHOR_HEIGHT = 3_783_210;
const ANCHOR_MS = Date.UTC(2026, 9, 13, 22, 40);
const FRESH_MARGIN_BLOCKS = 720;        // one day: a wallet created now cannot hold anything older

/** The shell's `network` config: missing = the shell default, mainnet. */
const isMainnet = (network?: string | null) => network == null || network === '' || network === 'mainnet';
const liveTip = (tip: number | null | undefined): tip is number => Number.isSafeInteger(tip) && (tip as number) > 0;
/** The tip a node would report now, from the anchor — mainnet only (null elsewhere). */
function anchorTip(now: number, network?: string | null): number | null {
  if (!isMainnet(network)) return null;
  return ANCHOR_HEIGHT + Math.floor(Math.max(0, now - ANCHOR_MS) / BLOCK_MS);
}

/** Convert a wallet birthday into a conservative height. Uses the live daemon tip when a node has
 *  answered; otherwise (first boot, no node yet) the anchor-estimated tip — on MAINNET only; on any
 *  other network with no tip there is no estimate (null: enter a height or wait for the node).
 *  Early-chain dates return genesis rather than risk skipping funds.
 *  The ripley-os original's vector table is mirrored in restoreHeight.test.ts — change both together. */
export function moneroRestoreHeightFromDate(date: string, tipHeight: number | null | undefined, now = Date.now(), network?: string | null): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const birthday = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(birthday) || birthday > now) return null;
  if (birthday < TWO_MINUTE_ERA) return 0;         // genesis is safe on any network, tip or not
  const tip = liveTip(tipHeight) ? tipHeight : anchorTip(now, network);
  if (tip == null) return null;
  const blocksSince = Math.ceil((now - birthday) / BLOCK_MS);
  return Math.max(0, tip - blocksSince - SAFETY_BLOCKS);
}

/** Where a wallet created NOW (from the unified seed, so the shell cannot tell it from an import)
 *  should start scanning: a day below the live tip when a node has answered, else (mainnet only) a
 *  day below the anchor-estimated tip, minus a further week of safety because an estimate is an
 *  estimate. Off mainnet with no tip: undefined — the caller passes no height and relies on the
 *  create call's `fresh: true` (the shell then starts at its own tip). */
export function moneroFreshWalletHeight(tipHeight: number | null | undefined, now = Date.now(), network?: string | null): number | undefined {
  if (liveTip(tipHeight)) return Math.max(0, tipHeight - FRESH_MARGIN_BLOCKS);
  const estimated = anchorTip(now, network);
  if (estimated == null) return undefined;
  return Math.max(0, estimated - FRESH_MARGIN_BLOCKS - SAFETY_BLOCKS);
}
