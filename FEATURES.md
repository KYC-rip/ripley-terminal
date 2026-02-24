# 📟 GHOST_TERMINAL :: FEATURE_LOG

This file tracks the tactical capabilities of the Ghost Terminal.

## 🛡️ Security & Privacy (Core)
- [x] **Mandatory Tor Routing**: All outgoing traffic is forced through SOCKS5 Tor tunnels. No Clearnet fallback allowed.
- [x] **Vault Lock**: Master Password encryption for local identity files. No keys are stored in plain text.
- [x] **Auto-Lock Timeout**: Securely close and lock the identity after a period of inactivity (default 10 min).
- [x] **Persistent Storage**: Physical `.keys` file management with auto-save checkpoints during sync.
- [x] **Hardware Isolation**: Local environment execution with zero reliance on centralized database servers.

## 🌪️ On-Chain Privacy (Tactical)
- [x] **One-Click Churn**: Sweep entire unlocked balance back to self via fresh subaddresses to break deterministic links.
- [x] **Individual Coin Vanishing**: Selectively sweep individual UTXOs (Deterministic Outputs) back to the primary address using `sweep_single` to isolate trailing transactions.
- [x] **Subaddress Vanishing**: Sweep all outputs from a specific subaddress to a freshly generated one using `sweep_all` with `subaddr_indices`, breaking on-chain linkability at the subaddress level.
- [x] **Coin Control (UTXO)**: Detailed list of every deterministic output (unspent) with unlock status and Key Image tracking.
- [x] **Forced Subaddressing**: Mandatory new subaddress generation for every receive request to prevent metadata leakage via address reuse.
- [x] **Identity Labeling**: Attach purpose-driven labels to subaddresses for precise ledger management.
- [x] **Per-Subaddress Balances**: Real-time balance display per subaddress via `getbalance` RPC with `per_subaddress` data.

## 🆔 Identity Management
- [x] **Multi-Identity Support**: Create and manage multiple isolated cryptographic vaults with distinct passwords and files.
- [x] **Account Indexing**: Create and switch between multiple deterministic accounts within the same cryptographic identity.
- [x] **Identity Switcher**: Secure hot-swapping between identities via the tactical authorization screen.
- [x] **Identity Ledger**: High-density transaction history with flow analysis, block heights, network fees, and destination decoding.
- [x] **Expandable Histories**: Deep dive into individual transactions to view exact confirmations, recipient address splits, payment IDs, and robust privacy-protected fallbacks.
- [x] **Subaddress Recognition**: Transaction ledger automatically maps incoming and outgoing transactions to known subaddresses, replacing raw hashes with friendly labels.

## 📊 Tactical Interface
- [x] **Sidebar Navigation**: Professional layout for rapid access to Vault, Swap, and Intelligence tools.
- [x] **Global Theme Support**: Semantic Dark (Tactical), Light (Financial), and System modes with optimized contrast rendering.
- [x] **Custom Background Skins**: Upload custom local images (JPG/PNG/GIF) with opacity and position controls to personalize the terminal interface.
- [x] **Local Intel Feed**: Real-time XMR market data and network pulse (Hashrate, Fees, Mempool).
- [x] **Local Chart Rendering**: Integrated `lightweight-charts` engine for theme-aware, interactive market analysis.
- [x] **Address Detail Modal**: Click any subaddress row to open a full-featured modal showing QR code, address, and payment link.
- [x] **Tactical Action Modals**: Dedicated interface overlays for executing sensitive on-chain actions like UTXO Churns and Splinters without cluttering the main UI.

## 💸 Asset Bridging
- [x] **Ghost_Swap Integration**: Quote and execute non-custodial asset swaps directly into your private vault via kyc.rip routing.
- [x] **Cross-Chain Payment Links**: Generate shareable `kyc.rip/swap?source=pay` links that let external payers choose any asset — funds settle automatically into your XMR subaddress.
- [x] **Ghost Send**: Send XMR from your vault — receiver gets BTC, USDT, ETH, or any supported asset. Quote, confirm, and auto-dispatch through the kyc.rip swap engine with zero identity link.
- [x] **Address Book**: Securely archive external Monero addresses with alias support for rapid dispatching.
- [x] **Send From Subaddress**: Dispatch XMR or execute Ghost Sends scoped to a specific subaddress for granular coin control.
- [x] **xmr.bio Resolver**: Send funds instantly to Twitter handles—automatically fetching Monero addresses from `api.xmr.bio` and displaying beautiful profile cards inline.

## 📦 Deployment & Execution
- [x] **Automated Packaging**: Cross-platform Electron build system (macOS `.dmg`, Windows `.exe`, Linux `.AppImage`).
- [x] **Secure Subtree CI/CD**: Custom deployment scripts that scrub the Git git-history for anonymity and push to a clean, public-facing repository natively.

---
*Last Updated: 2026-02-24*
