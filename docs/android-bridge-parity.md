# Android Terminal bridge milestone (DEBUG/stagenet only)

Local follow-up to 3946268. Actual bundled pinned GHOST IV ROS is used; current private frontend was not rebuilt.

Verified on Android 15/API35 x86_64 emulator: desktop layout with honest Android runtime status; actual ROS Wallet public-fixture restore, native confirmation Cancel/Approve, encrypted .vault reopen, native receive subaddress/QR. No funds, signing, mainnet, or secret export. Public test password ANDROID-STAGENET-TEST-ONLY; import only the published Cake fixture.

Native scanner attempt fails against the configured stagenet node with HTTP500; full scanner/rescan are NOT implemented. Host badge reports this explicitly; old frontend still displays Connecting.

ROS Browser opens Wikipedia in separate bridge-free Android Activity (globals __TAURI__, __rosNative, ipc undefined). It is not an embedded desktop view.

Native save/export integration implemented. First real Notepad export exposed immediate blob URL revocation; fixed by retaining Blob synchronously, regression unit test passes. Final save-picker retest pending at checkpoint.

Production remains keyless. Wallet .vault uses shared Argon2id/ChaCha20Poly1305 storage; output .cache remains unsealed JSON (empty test cache), no Keystore claim. Tor, VPN, background sync, AI inference, gateway/spend grants, signing and secret exports unavailable.

Evidence: /workspace/android-ros-poc/evidence/bridge-parity/. APK: /workspace/android-ros-poc/ros-android-bridge-parity-x86_64-debug.apk. ARM64 artifact predates the final export/schema patches; do not represent it as final verified build.

Checks: 76 existing JS tests + typechecks + renderer build passed; 7 new bridge tests, 11 pure policy tests, 2 shared time tests passed. Android x86 final build passed. Desktop Rust check blocked at glib-sys because pkg-config is absent. No push/PR.
