# Ghost Terminal - Pending Issues & Tactical Tasks

## 1. Core Sync & State Feedback (Critical)
- [x] **UI Progress Flickering**: UI height and percentage weren't updating in real-time.
    - *Resolved*: Switched to RPC-based polling and implemented `SyncWatcher` for reliable state pushing.
- [x] **Tor Readiness Detection**: Sync starting before Tor was fully bootstrapped.
    - *Resolved*: Added strict `isTorReady` checks in the authorization and unlock flows.

## 2. Persistence & Identity
- [x] **Secure Shutdown**: High risk of database corruption during abrupt app termination.
    - *Resolved*: Implemented instant window hiding and a forced 8-second timeout for graceful RPC `store` completion.
- [x] **Identity Renaming**: Wallet labels were fixed at creation.
    - *Resolved*: Implemented identity renaming in `SettingsView` and `IdentityHandler`.
- [ ] **Load/Save Stability Validation**: Long-term stress testing for data integrity under heavy I/O.

## 3. Features & Assets
- [x] **Multi-Account Support**: App only supported Account 0.
    - *Resolved*: Implemented high-fidelity Account Drawer with account selection, balance previews, and inline renaming.
- [x] **Subaddress Label Editing**: Inability to rename generated subaddresses.
    - *Resolved*: Implemented inline editing in the address list component.
- [ ] **Swap Quote Stability**: Occasional "trade could not be generated" errors over Tor.
    - *Tactical*: Monitoring Houdini API response times and packet fragmentation over onion routes.

## 4. UI/UX Refinements
- [x] **Master Seed Security**: Direct reveal of 25-word seed without confirmation.
    - *Resolved*: Added security warning and secondary confirmation prompt before revealing keys.
- [x] **Log Leveling**: Console output was difficult to parse.
    - *Resolved*: Implemented color-coded levels: `INFO`, `SYNC`, `ERROR`, `SUCCESS`.
- [ ] **QR Code Optimization**: Styling and sizing refinements for the Receive view.

## 5. Infrastructure & Internationalization
- [x] **Codebase Language Cleanup**: Removed all Chinese comments, logs, and UI strings across the `desktop/src` and `desktop/scripts` folders.
- [x] **Multi-Platform CI/CD**: Setup GitHub Actions for automated macOS and Linux builds.
- [x] **Open-Source Decoupling**: Successfully split the `desktop` folder into a standalone repository using Git Subtree.

---
*Last Updated: 2026-02-23*