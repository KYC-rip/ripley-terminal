# Pinned node: say WHY it failed

## Problem
2026-10-13: the user's mnr.network token had expired. mnr answers every call with HTTP 403 and the
JSON-RPC envelope `{"error":{"code":-32001,"message":"subscription expired"}}`. The Terminal logged
only "🔌 Pinned node unreachable — falling back to the public pool…", which sent the user to debug DNS,
proxies and the node's uptime. The reason was known to the process the whole time and dropped twice:

1. `reqwest_transport::do_post` hands a 4xx envelope to monero-oxide (correct — that is the db27ce8
   fix), but `MoneroDaemon::new`'s batch probe only keeps the error CODE
   (`InvalidInterface("… code Some(-32001)")`), never the message.
2. `DaemonConnector::connect` returns `Option<MoneroDaemon>` — `.ok()` in the clearnet connector, `None`
   in the Tor/SOCKS ones — so `race_list` / `race_nodes` cannot report anything.

## Change

### 1. `src-tauri/src/wallet/reqwest_transport.rs` — remember the last refusal
- `ReqwestTransport` gains `last_refusal: Arc<std::sync::Mutex<Option<String>>>`.
- `do_post` takes it; on a non-2xx whose body is an envelope, it stores
  `format!("HTTP {status} · {message} ({code})")` built by a new pure
  `fn refusal_summary(status: u16, body: &[u8]) -> Option<String>` (message capped at 120 chars,
  control characters stripped; the summary never includes the URL). The envelope is still returned to
  monero-oxide exactly as today.
- `ReqwestTransport::connect` maps a `MoneroDaemon::new` error to: the stored refusal when there is
  one ("node refused: HTTP 403 · subscription expired (-32001)"), else today's "daemon init failed: …".
- Tests: `refusal_summary` on the mnr 403 body, on an oversized/HTML body (None), on a message with
  control characters; the existing `node_urls_are_never_formatted_raw` source scan keeps guarding that
  no raw URL is formatted.

### 2. `src-tauri/src/wallet/scanner.rs` — carry the reason to the log
- `DaemonConnector::connect` returns `Result<MoneroDaemon<T>, String>`; the Tor/SOCKS connectors return
  `Err(format!("{e:?}"))` (they already log with the redacted URL; the string carries no URL).
- `race_list` returns `RaceOutcome { winner: Option<(label, url, daemon)>, failures: Vec<(label, reason)> }`.
  Failures go on a second, unbounded channel and are sent BEFORE the task's winner sender drops, so when
  the winner receiver yields None (every task done) every reason is already queued; the outcome drains the
  failures channel after the select. The 15 s cap is unchanged. The winner path is identical.
- Call sites adapted: `run_outer` (pinned branches + the fallback-pool `race_list`), `pool_loop`
  (`race_nodes(...).winner`), and `build_fallback_pool`'s `buffer_unordered` collect (`.ok()`).
- `last_refusal` is created fresh inside `ReqwestTransport::connect` for each probe, so a refusal read
  after a failed `MoneroDaemon::new` is that probe's own; later mid-scan refusals on the same transport
  overwrite it but nobody reads it then.
- `run_outer`'s pinned-node branches use the reason:
  - fallback on: `🔌 Pinned node refused: HTTP 403 · subscription expired (-32001) — falling back to the public pool…`
  - fallback off: `❌ Pinned node <redacted url> refused: … — check the address or clear the pin in Settings ▸ Node. Retrying in 10s...`
  - no reason within 15 s: today's wording plus "(no answer in 15 s)".
- A one-line hint for the two mnr codes the user can act on, appended when the pinned host is
  `rpc.mnr.network`: `-32001`/"subscription expired" → "renew the token at mnr.network";
  `-32600`/"unknown token" → "get a new token at mnr.network and paste it in Settings ▸ Node". Pure
  `fn pinned_hint(url_host: &str, reason: &str) -> Option<&'static str>`, tested.
- Public-pool races stay quiet on individual failures (a dozen nodes race every time); failures are
  logged at `log::debug!` only, redacted.

### 3. Release
Rebuild the Terminal (`\npm run tauri:build`), install, relaunch; verify with the expired token still
pinned that the log shows the refusal line and the hint, then re-verify with a fresh free token that
the pin connects (the `node_probe` ignored test, `RIPLEY_PROBE_NODE=<url>`, still passes).

## Out of scope
- Token management in Settings (renew link, expiry countdown) — the hint names the site; a Settings
  affordance is a separate UI change.
- Changing mnr's 4xx-with-envelope behaviour (their side; documented in docs/mnr-network.md).

## Risks
- The refusal message is daemon-supplied text shown in the log: capped, control-stripped, never
  interpreted. It cannot contain the token (mnr never echoes it; the cap + the URL guard cover the
  general case).
- `Mutex` poisoning is impossible to hit meaningfully (one `Option<String>` write); use `lock().unwrap_or_else(|p| p.into_inner())`.

## Review
OpenCode plan review 2026-10-13: PASS 8.4 (clarity 8.5, completeness 8.0, feasibility 8.5, risk 8.0,
alignment 9.0). Folded in: all call sites enumerated (run_outer, pool_loop, build_fallback_pool),
`last_refusal` fresh per probe, failures-channel send/drop ordering stated; the mnr-only hint is
intentional (a self-hosted node's codes mean whatever its operator set). Also added `redact_text` so a
Tor/SOCKS connector's Debug error can be carried as a reason without a node path.
