# Android native runtime POC (experimental; NOT a production wallet)

Base: `feat/ros-integration` at `59176fdfb12450006b68caeaa93785fd8a530692`.

## What this demonstrates

A real Tauri Android application hosting the actual hash-verified bundled ROS UI
(`src-tauri/resources/ros-fallback.tar.zst`), not a new mock UI. Rust wallet crypto,
storage, scanner and Arti dependencies compile into the native Android library.
The desktop entry point is preserved in `src-tauri/src/desktop.rs`.

The host supplies a deliberately reduced `__rosNative` adapter with native signing,
Tor, embedded-browser and Keystore capabilities **false**. Generic HTTP/WebSocket/
remote media is blocked by CSP or the explicit unsupported adapter, not silently
sent in the clear. Only manually triggered diagnostic network calls run. This is
an offline/read-only shell POC, NOT the full Terminal feature set.

DEBUG builds offer a separate host-owned diagnostics page. The commands check the
native WebView's label, exact origin and exact path plus debug-build status.
There is no raw-key IPC, arbitrary destination/seed/network argument, production
wallet command or broadcasting operation. A stagenet test opt-in creates a fresh
throwaway seed entirely in Rust; **the test password is public and the wallet MUST
NEVER RECEIVE FUNDS OF VALUE**. It is not connected to ROS's main wallet UI.
Release builds reject every diagnostic operation before touching storage/network.

- Real create/restore via Terminal's `wallet/keys.rs`.
- Real Argon2id + ChaCha20-Poly1305 encrypted wallet files via `wallet/storage.rs`.
- Reopen/wrong-password/tampering checks; no secrets returned to JS or printed.
- Real one-block stagenet fetch/scan when the fixed public node is reachable.
- Real Arti bootstrap/onion-node check, bounded to 100 seconds, no direct fallback.
- Native confirmation dialog denial test; no transaction is submitted.
- Kotlin `onPause` calls a native Rust lock; restart is always locked. An epoch
  prevents an in-flight wallet test from restoring an unlocked session after lock.
- Android backup and device transfer are disabled/excluded.

There is **no Android Keystore integration**, production signing, resumable wallet
service, push, mobile browser/X embed, VPN or local AI support. Wallet storage is
software-encrypted test storage, not hardware-protected custody.

## Build

Install JDK 21, Android SDK/NDK, GNU make/Perl and a current Rust toolchain. Use isolated SDK,
Cargo/Gradle/AVD homes on shared machines. Tested tool versions/results are in the
verification record. No signing credentials are stored in this repository.

```sh
export JAVA_HOME=/path/to/jdk
export ANDROID_HOME=/path/to/android-sdk
export NDK_HOME="$ANDROID_HOME/ndk/28.2.13676358"
# cc/openssl-src must use the LLVM tools (the old triplet-ranlib no longer exists).
export RANLIB_x86_64_linux_android="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ranlib"
export AR_x86_64_linux_android="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-ar"
# Use corresponding aarch64_linux_android variables for an ARM64 build.
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"
rustup target add x86_64-linux-android aarch64-linux-android
# Tauri CLI 2.11.x; beforeBuildCommand is intentionally disabled for the Android
# target: the real ROS fallback bundle is already in the repository.
cargo tauri android build --debug --target x86_64 --apk
# Or use the npm CLI, with its executable on PATH or TAURI_ANDROID_CLI set to
# the installed node_modules/.bin/tauri path, so the Gradle callback can find it.
```

The generated Android project is tracked. `tauri.android.conf.json` selects only
the Android capability files: do not union in the desktop capability files.
Keep `http://ros.localhost` stable: changing scheme changes WebView storage origin.

## Emulator verification

```sh
sdkmanager 'platform-tools' 'emulator' 'platforms;android-36' 'build-tools;36.0.0' \
  'ndk;28.2.13676358' 'system-images;android-35;default;x86_64'
avdmanager create avd -n ros-poc-api35 -k 'system-images;android-35;default;x86_64'
emulator -avd ros-poc-api35 -no-window -no-audio -no-snapshot -no-metrics \
  -gpu swiftshader_indirect -cores 2 -port 5580
adb -s emulator-5580 install -r /path/to/debug.apk
adb -s emulator-5580 shell am start -n run.ripley.androidpoc/.MainActivity
adb -s emulator-5580 exec-out screencap -p > ros-launch.png
```

Open **Android POC diagnostics** in the running actual ROS UI, explicitly opt in,
run each check, and inspect the public result JSON. Native test reports are under
`android-poc` in the app-private data root (verified with `run-as`). To inspect:

```sh
adb -s emulator-5580 shell run-as run.ripley.androidpoc ls -R android-poc
adb -s emulator-5580 shell input keyevent KEYCODE_HOME
adb -s emulator-5580 shell am start -n run.ripley.androidpoc/.MainActivity
# Scan must now refuse until the explicit wallet check is rerun.
adb -s emulator-5580 shell am force-stop run.ripley.androidpoc
adb -s emulator-5580 shell svc wifi disable
adb -s emulator-5580 shell svc data disable
adb -s emulator-5580 shell am start -n run.ripley.androidpoc/.MainActivity
# Actual bundled ROS must launch offline; reopen must find the same sealed test wallet.
adb -s emulator-5580 shell svc wifi enable
adb -s emulator-5580 shell svc data enable
```

Test hostile navigation (must stay on the local page), unknown/wallet commands
(must reject), native confirmation **Cancel**, background and process-death lock,
network interruption/recovery and encrypted reopen. UIAutomator/adb are actual
Android tests; browser phone emulation is not a substitute.

`./scripts/android-poc/check-policy.sh` runs the pure Rust policy tests without
GTK dependencies and checks the desktop source move. Host desktop compilation,
funded transaction preparation/signing and real ARM64-device performance are
separate checks and must not be inferred from emulator success.

## Production gates

Separate auditable custody modes; no silent mobile-custody promotion. Implement
Android Keystore wrapping and authentication with recovery semantics; review all
secret lifetimes and plaintext-cache fallbacks before enabling real wallets.
Replace debug test credentials. Add native transaction review with authoritative
amount/destination/fee, an IPC audit and hostile-frame instrumentation. Implement
checkpointed background services under Android quotas, battery/memory testing and
routing leak tests for every protocol. Audit APK signing/update policy, dependency
security and 16-KB native-library alignment; test real ARM64 hardware. The POC
must never be marketed as production-ready or blanket Tor protection.
