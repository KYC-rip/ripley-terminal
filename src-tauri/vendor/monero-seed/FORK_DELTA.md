# FORK_DELTA — ripley-terminal vendored monero-seed

Vendored copy of `seed/` from `github.com/kayabaNerve/monero-wallet-util` at commit
`797fe701a6f9e99ae614c49479bb981de1afe8ec` (the commit Cargo.lock pins), wired in via
`[patch."https://github.com/kayabaNerve/monero-wallet-util"]` in `src-tauri/Cargo.toml`.

One **additive** delta in `src/lib.rs`: `Seed::raw_entropy_from_string(lang, words)` — the
existing private `seed_to_bytes` exposed, i.e. word + checksum validation WITHOUT the
canonical-scalar check that `from_string` applies. wallet2 restores a non-canonical legacy seed
by reducing it (sc_reduce32); Cake Wallet's 25-word export of a Polyseed wallet encodes the
unreduced Polyseed key, so without this ~15/16 of those exports cannot be restored.
`keys.rs` uses it only after `from_string` fails, and reduces the bytes itself.

Manifest changes (not code): dropped `[lints] workspace = true` and the dev-dependencies
(a path dependency outside its workspace cannot inherit lints). The upstream tests are kept
but not built here.

Rebase: copy the new upstream `seed/` and re-apply the one function above.
