# Android Terminal bridge milestone (DEBUG/stagenet only)

Local follow-up to 3946268. Actual bundled pinned GHOST IV ROS is used; current private frontend was not rebuilt.

Verified on Android 15/API35 x86_64 emulator: desktop layout with honest Android runtime status; actual ROS Wallet public-fixture restore, native confirmation Cancel/Approve, encrypted .vault reopen, native receive subaddress/QR. No funds, signing, mainnet, or secret export. Public test password ANDROID-STAGENET-TEST-ONLY; import only the published Cake fixture.

Native scanner attempt fails against the configured stagenet node with HTTP500; full scanner/rescan are NOT implemented. Host badge reports this explicitly; old frontend still displays Connecting.

ROS Browser opens Wikipedia in separate bridge-free Android Activity (globals __TAURI__, __rosNative, ipc undefined). It is not an embedded desktop view.

Native save/export integration implemented. First real Notepad export exposed immediate blob URL revocation; fixed by retaining Blob synchronously, regression unit test passes. Final actual save-picker retest PASS: Downloads/ANDROID_POC_CLIPBOARD_TEST.md contains the exact 26-byte public note.

Production remains keyless. Wallet .vault uses shared Argon2id/ChaCha20Poly1305 storage; output .cache remains unsealed JSON (empty test cache), no Keystore claim. Tor, VPN, background sync, AI inference, gateway/spend grants, signing and secret exports unavailable.

Evidence: /workspace/android-ros-poc/evidence/bridge-parity/. APK: /workspace/android-ros-poc/ros-android-bridge-parity-x86_64-debug.apk. ARM64 was rebuilt from the final functional source; compile-only, never represented as device-tested.

Checks: 76 existing JS tests + typechecks + renderer build passed; 7 new bridge tests, 11 pure policy tests, 2 shared time tests passed. Android x86 final build passed. Desktop Rust check blocked at glib-sys because pkg-config is absent. No push/PR.

Final emulator checks: gateway status renders disabled/no listener/UNAVAILABLE, Rotate rejects with readable UNSUPPORTED_ANDROID. Backend background lock invalidates actual Wallet get_accounts/get_balance calls; offline force-stop/relaunch loads actual ROS with wallet locked. Security logs verify hostile iframe CSP denial plus unknown/raw-secret/signing/mainnet/Tor-bypass/POST/private-network denials. See evidence REPORT.md/results.json/artifacts.json.
