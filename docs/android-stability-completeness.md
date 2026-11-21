# Android stability/completeness milestone (experimental, local)

Baseline host41e17c1 / current ROS fd6a9d1. No production custody or spending enabled.

## Native API audit and priorities

| Area / ordinary ROS apps | Desktop assumption | Android result / boundary |
|---|---|---|
| Wallet | Native core and private vault | Real shared Rust create/restore/unlock/scan/accounts/subaddresses/history, receive-only DEBUG. Canonical/spent/reorg checkpoint mechanisms preserved. Serialized mutations and independent wallet-session fencing added; unsupported spending/seed/key export stays denied. |
| Settings/window state/browser bookmarks and namespaced ROS preferences | `ros_kv_load/set/remove/clear` native persistence | Previously missing: reuse actual path-locked Terminal implementation, Android fsync+rename durability; frontend existing verified migration probes activate it. Not general filesystem access; values have existing ROS application encryption only. |
| Calculator, Wallet address copy, Explorer/Privacy/Vault clipboard | WebView clipboard permissions differ from OS clipboard | Explicit foreground-only native text copy/read,64K-character bound, sensitive-preview flag, no URI coercion/provider reads; wired to ordinary navigator clipboard calls. |
| System/Planner local alerts | Desktop notification plugin | Actual Android plugin + permission flow; no push server and no background scheduling/Doze guarantee. |
| Notepad/export; Settings/Image import | Desktop dialogs/filesystem | Existing Android save-document picker and WebView upload picker, user-cancel supported. No arbitrary user filesystem paths. |
| Browser/X | Child desktop WebViews and Tor routing | Separate bridge-free public HTTPS Android Activity, explicitly clearnet. No all-app Tor, embedded X, cookie extraction or fake embedding. |
| Tor/VPN | Process/proxy/system VPN integration | Explicit unavailable; no silent direct fallback. |
| Ripley local AI / gateway / OS shell | Desktop processes/listeners/native engines | Explicit unsupported/error; no fake daemon readiness. Existing frontend planner shell is not a real Android shell. |
| Device windows/capture/updater/biometrics | Desktop APIs / signing policy | Desktop window management and screen capture not ported; release signed OTA pins unchanged. No biometric/hardware-security claim. |

API counts and every desktop command status are generated in the local evidence API inventory (no private frontend source copied). ACL-denied and structured unsupported are distinguished from implemented handlers; handler inventory alone is NOT app verification.

## Stability fixes
- Old scan failure cannot invalidate the replacement wallet's balance/verification or publish late ERROR events. Capture wallet session before network waits; reorg scanner generations remain separate.
- Serialize create/open/close/switch and metadata mutations; lock previous keys before attempting a new unlock. Wrong-password unlock never leaves previous wallet open.
- Delayed background-lock tasks check their session ticket before changing a newly reopened wallet. Lock invalidates scanner generation before saving.
- Generation/session fences reject old async read responses; event bridge drops older wallet-session logs.
- Android vault and identity metadata use synced atomic writes; preserve desktop cfg behavior.

## Keystore decision (NOT implemented / capability remains false)
Official Android Keystore AES/GCM keys are non-exportable and device-bound, but cannot be restored with the password on another installation. This POC deliberately forbids recovery/seed export to JS, and newly generated test wallets have no native encrypted backup/recovery flow. Replacing existing password vaults with device-only wrapping now could strand them on key invalidation/uninstall. Keeping a password-only plaintext-equivalent fallback next to the wrapped file would negate the claimed device binding. Therefore no fake Keystore success or destructive migration is enabled in this milestone. A safe follow-up needs an explicit native encrypted recovery/export design, authenticated reopen-before-delete migration, invalidation recovery UI and restore tests. Existing Argon2id/ChaCha20Poly1305 vault/cache encryption and recovery semantics remain unchanged; no hardware-backed claim.

References: https://developer.android.com/privacy-and-security/keystore ; https://developer.android.com/privacy-and-security/risks/backup-best-practices

## Verification
Actual emulator tests and exact artifact/source revisions are recorded after final builds under `/workspace/android-ros-poc/evidence/stability-completeness/`. No real funds, no mainnet transaction preparation/signing/sending. All local spending tests use official valueless FAKECHAIN only.

### Additional genuine UI findings fixed
- Restored Wallet was above the usable screen and larger than the desktop; shared geometry now clamps restored/resized windows. Pure geometry tests and actual emulator lock/titlebar controls verified.
- Tauri Android permission probe returns `null` for Prompt, not false. The frontend now requests actual OS permission unless it is explicitly true. Native alerts also refuse without Granted; attachments and broad raw notification APIs stay unavailable. Actual Settings -> Android permission Allow -> delayed test -> Home produced a real NotificationRecord and notification-tray screenshot.
- Android get_accounts previously returned cached zero labels even when wallet total was nonzero. It now injects shared native live per-account totals like desktop, while unlocked/spendable always stays zero.
- Own failed-open lock event used to cancel its own pending frontend error, hiding wrong-password feedback. Failure broadcasts are now emitted under the serialized native operation with a reason; they still clear all cached sensitive UI state but do not cancel their own error result. External/lifecycle/unknown locks still invalidate pending unlock completions. Final emulator regression is required for this last fix.

### Verification boundaries
Keystore, background services/Doze delivery, push-when-closed, native AI/VPN/gateway and full desktop shell remain unimplemented. Notifications tested are local alerts while the process remains alive, not scheduled/background-delivery guarantees. This delivery is an isolated official local FAKECHAIN debug build, not a production wallet; Android release custody and signed OTA trust pins are unchanged. ARM64 is compile/alignment checked only; no physical device or hardware-backed security claim. Desktop source preservation is tested, but a full Linux desktop compile requires unavailable pkg-config/GTK development dependencies.
