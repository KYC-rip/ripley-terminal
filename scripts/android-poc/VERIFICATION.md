# Android POC verification — 19 November 2026 (SGT)

Experimental debug build only. Base branch `feat/ros-integration` remained at
`59176fdfb12450006b68caeaa93785fd8a530692` when rechecked after implementation.
The same final Rust/Android sources were built for both ABIs. Only x86_64 was run.

## Results

| Check | Result |
|---|---|
| Android native Rust + Gradle APK, x86_64 | PASS |
| Android native Rust + Gradle APK, arm64-v8a | PASS build; NOT DEVICE TESTED |
| Actual bundled ROS launch; offline force-stop/relaunch | PASS |
| Versioned native runtime status, platform, ABI, capabilities | PASS |
| Fresh throwaway stagenet mnemonic create/restore equality | PASS |
| Software-encrypted wallet save/reopen; wrong password/tamper denial | PASS |
| Same public address after offline process death/reopen | PASS |
| ROS-page wallet diagnostic denial; unknown/raw-wallet commands denied | PASS |
| Remote navigation denial; hostile iframe blocked by CSP | PASS |
| Native dialog Cancel, no broadcast | PASS — dialog only, NOT a transaction |
| Explicit lock, Activity background lock, new-process locked state | PASS |
| Native stagenet block scan | NOT VERIFIED — get_info returned HTTP 500 |
| Radio disable/re-enable; subsequent native connectivity | Radio controls PASS; connectivity NOT VERIFIED (node unreachable) |
| In-process Arti Tor bootstrap | PASS |
| Stagenet onion query | NOT VERIFIED — onion unreachable |
| Spend preparation/signing | NOT VERIFIED — no test funds; no transaction created |
| Android Keystore, hardware-backed signing | NOT IMPLEMENTED |
| Rust pure policy tests / desktop source move | 9/9 PASS / PASS |
| Existing JS tests / typecheck / production renderer build | 76/76 PASS / PASS / PASS |
| Native desktop Rust compilation/full Rust test suite | NOT VERIFIED — host lacks pkg-config/GTK/WebKit development dependencies |
| ARM64 device behavior, release build, Android 16/17 | NOT VERIFIED |

`verification-result.json` is the actual final emulator harness output, not a
claim that the two unavailable network operations passed. The observed HTTP 500
was also seen from a no-wallet host request; this does not establish whether the
remote node or the environment's egress caused it. No alternative clear connection
is used when the Tor test fails. The fixed node is documented by its operator:
https://www.rino.io/community/tools/nodes .

Release denial was exercised as a policy test, not by installing a release APK.
The native dialog test has no prepared transaction and cannot prove production
transaction-confirmation enforcement. Background lock prevents future diagnostic
wallet use, but this POC is not a resumable/background scanner or a complete
secret-lifetime audit. No real wallets, user seeds, mainnet operations or funds
were used. Known secret-derivation logging was removed from the shared key module;
captured test logs were checked for that pattern and seed_entropy, not security-
certified by this check.

## UI provenance

The UI is the repository's actual offline fallback archive (currently visibly
branded **GHOST IV**), not the current live ros.rip release and not a placeholder.
SHA-256: `0ce529a1253d74b68766e626ef9b6c7556fbb0a5764bb7c4d7b7d27d1a40787c`.
Startup checks this against the upstream pinned digest before serving it. No
private ripley-os source was modified. Native production custody stays keyless;
the isolated debug test wallet is not wired into the ROS wallet UI.

## Toolchain and emulator

- Tauri CLI 2.11.5; Rust Tauri crate 2.11.1.
- rustc/cargo 1.100.0; Temurin JDK 21.0.13.1+2; Gradle 8.14.3.
- Android SDK compile/target 36, min 24; build-tools 36.0.0; NDK 28.2.13676358.
- Emulator 37.2.13.0, API 35 / Android 15, default x86_64 image.
- Actual headless KVM emulator, serial emulator-5580, 432x768 @160 dpi.
- System WebView 124.0.6367.219. No browser phone emulation was used.
- Single AVD, three Cargo jobs and at most two Gradle workers; isolated tool homes.

## Reproduction and local artifacts

See README.md for SDK setup and exact adb lifecycle commands. Final executed test:

```sh
python3 scripts/android-poc/verify-emulator.py --serial emulator-5580 \
  --apk /workspace/android-ros-poc/ros-android-poc-x86_64-debug.apk \
  --evidence /workspace/android-ros-poc/evidence/final-emulator
```

The harness clears ONLY the uniquely named `run.ripley.androidpoc` test package.
It exports public result reports and screenshots, not encrypted wallet contents
or private key material. Build logs, APKs and screenshots are local artifacts,
not checked into the source tree:

- `ros-android-poc-x86_64-debug.apk` (68,505,263 bytes):
  `f5d1ea8dc7831c647b588ff7b6acf5ad604db83fb0c010693c0ad5b78bac98e6`
- `ros-android-poc-arm64-debug.apk` (133,888,052 bytes; build only):
  `8a507de477b26eb8bec6266e1978161c31ffde112c1099de7d8e70f6742b370b`
- Both APK signatures verified by SDK apksigner; each APK contains only its named ABI.
- `evidence/final-emulator/01-actual-ros-ui.png`
- `evidence/final-emulator/02-diagnostics.png`
- `evidence/final-emulator/02b-native-confirmation.png`
- `evidence/final-emulator/03-offline-ros-relaunch.png`
- `evidence/final-emulator/04-offline-diagnostics.png`
- `evidence/final-emulator/verification.json`, `app-logcat.txt`, safe JSON reports.
- `evidence/build-{x86_64,arm64}-final.log`, `tool-versions.txt`,
  `policy-tests-final.log`, `js-tests.log`, `js-typecheck.log`, `renderer-build.log`.

Production gates remain those listed in README.md. In particular, no blanket Tor
protection, production signing, app-store readiness or ARM64 performance is claimed.
