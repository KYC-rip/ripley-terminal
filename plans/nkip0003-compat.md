# Ripley Terminal ↔ NKIP-0003 (Sign-In with Monero) full compatibility

## Context (2026-10-27)
NKIP-0003 (nkips.org/nkip-0003, vectors nkips/nkip-0003/vectors/v1.json) specifies the "sign in with a Monero wallet" flow the Terminal already does as `ripley://sign`. The sign-in screen and challenge parser live in ROS (loaded live from app.ros.rip) and already follow the spec (ROS 575989ab). Gaps in the Terminal:
1. It doesn't open `monero-signin:` links — only `ripley://` and `xmr402://` are registered (tauri.conf.json deep-link schemes), and ROS only parses `ripley:(//)sign`.
2. It produces SigV1 (`msg_sign.rs`); NKIP-0003 says wallets SHOULD produce SigV2 (domain-separated, bound to the address's spend + view keys, the wallet-rpc default since 0.17).
3. Its signer was never checked against official Monero: `validates_against_real_monero_signature` is `#[ignore]` with REPLACE_ME values. Only self round-trips are tested.
4. R7 (paste / QR) is unverified.

## Change
**Terminal (Rust, `src-tauri/src/wallet/msg_sign.rs`, `commands/wallet.rs`):**
- `message_hash_v2(msg, addr_spend_pub, addr_view_pub, mode)` = keccak256("MoneroMessageSignature\0" ‖ spend_pub ‖ view_pub ‖ mode ‖ varint(len) ‖ msg) — wallet2 `get_message_hash`; mode 0 = spend.
- `sign_message_v2(msg, spend_sec, addr_spend_pub, addr_view_pub)` → `"SigV2…"`; same Schnorr core as V1 (refactored into one `sign_hash` / `verify_hash`), the signing key is the address's spend secret (subaddress-derived for subaddresses), the hashed keys are the target address's own public spend/view keys.
- `verify_message_v2` (spend mode) for tests.
- `sign_message` command signs SigV2 using `target.spend()` / `target.view()`; it asserts `spend_sec·G == target.spend()` first (refuse on mismatch).
- Tests (all from the NKIP-0003 vectors, made/verified by monero-wallet-rpc v0.18.4.5): un-ignore the real-Monero test with the vector SigV1; verify the two wallet-rpc SigV2 vectors (primary + subaddress 0/1); signing with the published test-wallet keys (primary and derived subaddress 0/1) produces SigV2 that our verifier accepts AND, checked once by hand, monero-wallet-rpc `verify` reports good / version 2 / spend (run offline against a throwaway wallet; result noted in the commit). A view-mode wallet-rpc signature must NOT verify as spend.
- `tauri.conf.json` deep-link schemes += `monero-signin`; the deep-link forwarder in lib.rs passes it to ROS like `ripley:`.

**ROS (`src/os/apps/intents.ts`, `platform/native.ts`, Browser, paste paths):**
- `parseRipleySignUri` accepts `monero-signin:?…` (the spec scheme) as well as `ripley:(//)sign?…` — same rules.
- Deep-link router + in-OS Browser navigation intercept send `monero-signin:` to `osHandleSiwr`.
- Paste: find where pasted `xmr402:` / payment URIs are handled (Browser address bar, palette) and route `monero-signin:` / `ripley://sign` the same way; QR = any scanner that yields text into those paths (check whether a scanner exists).
- Tests: parser accepts the NKIP-0003 vector URIs (with `monero-signin:`) and the message matches the vector bytes exactly.

## Not in scope
Server (xmr.bio) changes — its verifier is wallet-rpc `verify` at xmr.kyc.rip (behind Cloudflare Access, version not queryable without the service token). SigV2 needs wallet-rpc ≥ 0.17. The same wallet-rpc verifies live XMR402 / Pro payment proofs with `check_tx_proof`, which requires parsing current (post-2022 hard fork, BP+) transactions — impossible below 0.18 — so it is ≥ 0.18 and accepts SigV2.

## Ship
cargo test (msg_sign) + vitest + tsc; ROS deploy (clean worktree); Terminal commit + native build, ad-hoc signed, install. Verify: a real xmr.bio sign-in with the rebuilt Terminal (needs Anton) — before shipping SigV2, confirm the xmr.bio verifier accepts it.

## Plan review (OpenCode 8.0) — folded in
- Fallback: a challenge is single-use, so no runtime retry; the frontend passes the signature version (`SIG_VERSION` in ROS walletService), so going back to SigV1 is a web deploy.
- R7 concrete: OS deep link (native.ts DEEP_LINK), in-OS Browser link clicks (native embed intercept → `ros:browser-uri`) and typed/pasted address-bar input, and the command palette (a pasted challenge → one "Sign in to … as @…" row). No QR scanner in the desktop wallet (QR is the transport to phone wallets); a malformed challenge is reported, never loaded as a web URL.
- Scheme forms tested: `monero-signin:?…`, `monero-signin:…`, `ripley://sign`, `ripley:sign`; `monero-signin://…` refused.
- Negative crypto tests: primary key signing for the subaddress, wrong view key, view-mode signature.
- NKIP-0003 was tightened meanwhile (6a3eb32: handle/nonce/session/purpose character rules, unknown parameters refused, NFC); ROS now passes all 2 valid / 25 invalid spec vectors (fixture copied into ROS). Live xmr.bio challenges conform (32-hex nonce, UUID session, purpose login).
- Hand check done: Terminal-made SigV2 for the primary and subaddress 0/1 → monero-wallet-rpc v0.18.4.5 verify: good, version 2, spend.

## Code review (OpenCode 8.2 PASS) — then fixed
- R10 / wallet rule 6: the in-OS Browser passes the page a sign-in link was clicked on (the webview's real URL from load events, not the typed one); a page whose registrable domain differs from `origin` is refused with a notice, nothing shown or signed.
- R6 "own site" now uses the Public Suffix List (tldts 7.4.3, private section, lazy-loaded; added as a direct dependency at the version already in the lockfile); the consent shows "different site" until the answer arrives.
- Parser: impossible calendar dates (2026-02-30) refused, a present-but-empty `purpose` refused, empty user info in `return_url` refused, a typed `monero-signin://…` reported as malformed (not searched).
- msg_sign.rs header rewritten for SigV2 and the official-Monero check.
