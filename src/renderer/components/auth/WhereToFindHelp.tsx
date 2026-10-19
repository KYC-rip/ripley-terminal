import { useState } from 'react';
import { ChevronDown, ChevronRight, HelpCircle } from 'lucide-react';

/*
 * Where each wallet keeps its seed and its address + private view key. Paths checked 2026-10-19:
 *
 * Feather — seed: "Go to Wallet → Seed or press the seed icon in the status bar"; 16-word Polyseed
 *   for wallets Feather created, "Show 25 word seed" converts.
 *     https://docs.featherwallet.org/guides/show-wallet-seed
 *     https://docs.featherwallet.org/guides/seed-scheme
 *   keys: Wallet → Keys (Primary address, Secret view key) — the docs do not name this menu; verified
 *   in Feather's own source instead:
 *     https://raw.githubusercontent.com/feather-wallet/feather/master/src/MainWindow.ui
 *     https://raw.githubusercontent.com/feather-wallet/feather/master/src/dialog/KeysDialog.ui
 * Cake Wallet — Settings (gear) → Recovery & Keys → "Show my Recovery Phrase & Keys"; phrase on the
 *   "Recovery Phrase" tab, private view key on the "Keys" tab. New Monero wallets are 16-word Polyseed.
 *     https://docs.cakewallet.com/tutorials/find-seed-phrase
 *     https://docs.cakewallet.com/cryptos/monero
 * Monero GUI — Settings → Wallet → "Show seed & keys" (the getmonero.org guides only cover the CLI
 *   `address` / `viewkey` commands; the button is verified in the GUI's source):
 *     https://getmonero.org/resources/user-guides/view_only.html
 *     https://raw.githubusercontent.com/monero-project/monero-gui/master/pages/settings/SettingsWallet.qml
 * Monerujo — open the wallet → menu (top right) → "Show Secrets!" → Details screen (Mnemonic Seed,
 *   View Key); 25 words. That the address shows there is NOT verified, so the copy doesn't claim it;
 *   Cake's docs don't say where the primary address is either — both get generic address wording. An optional seed "offset passphrase" exists since 2.3.1 (not supported here).
 *     https://www.monerujo.app/wallet-backup.html
 *     https://github.com/m2049r/xmrwallet/blob/master/app/src/main/res/values/strings.xml
 */
const WALLETS: Array<{ name: string; seed: string; keys: string }> = [
  {
    name: 'Feather',
    seed: 'Wallet → Seed (or the seed icon in the status bar). 16 words (Polyseed) — paste those; "Show 25 word seed" works too.',
    keys: 'Wallet → Keys: Primary address + Secret view key.',
  },
  {
    name: 'Cake Wallet',
    seed: 'Settings (gear) → Recovery & Keys → Show my Recovery Phrase & Keys → Recovery Phrase tab. New wallets use 16 words.',
    keys: 'Same screen, Keys tab: private view key. Use the wallet\'s primary address, not a receive subaddress.',
  },
  {
    name: 'Monero GUI',
    seed: 'Settings → Wallet → Show seed & keys. 25 words.',
    keys: 'Same screen: primary address + secret view key.',
  },
  {
    name: 'Monerujo',
    seed: 'Open the wallet → menu (top right) → Show Secrets! → Details. 25 words.',
    keys: 'Same Details screen: View Key. Use the wallet\'s primary address.',
  },
];

export function WhereToFindHelp({ mode }: { mode: 'phrase' | 'viewonly' }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-xmr-border/30 bg-xmr-base/40">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-xmr-dim hover:text-xmr-green transition-colors cursor-pointer"
      >
        <HelpCircle size={11} />
        <span>Where do I find it?</span>
        <span className="ml-auto">{open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          {WALLETS.map(w => (
            <div key={w.name} className="text-[10px] leading-snug">
              <div className="font-black uppercase tracking-widest text-xmr-green">{w.name}</div>
              <div className="text-xmr-dim">{mode === 'phrase' ? w.seed : w.keys}</div>
            </div>
          ))}
          <p className="text-[10px] text-xmr-dim/70 leading-snug">
            {mode === 'viewonly' ? 'The primary address starts with 4 on mainnet — one starting with 8 is a subaddress. ' : ''}
            Another wallet? In its settings, look for Seed, Backup or Keys.
          </p>
        </div>
      )}
    </div>
  );
}
