# GHOST_TERMINAL 🎭

> **Tactical Monero Desktop Wallet.**

`ghost-terminal` is a privacy-first, security-hardened Monero desktop wallet designed for sovereign wealth management. It serves as the local command center for the `kyc-rip` ecosystem, providing direct access to Monero's untraceable privacy features with a precise, tactical, terminal-inspired interface.

## 🚀 Vision
In an era of pervasive financial surveillance, `ghost-terminal` provides a local, hardware-agnostic encryption layer. It is built for those who demand absolute control over their digital assets and identity.

## 🛠 Tech Stack
- **Framework**: Electron + Vite
- **Frontend**: React 19 + Vanilla CSS (Tactical UI)
- **Engine**: High-availability Monero RPC Wrapper (Replaces `monero-ts` for multi-platform stability)
- **Networking**: Mandatory Tor routing via integrated Tor Expert Bundle
- **Reliability**: SWR caching and real-time state synchronization
- **CI/CD**: Multi-platform automated builds (macOS arm64/x64, Linux x64)

## 📦 Getting Started

### Prerequisites
- Node.js (Latest LTS)
- `pnpm`

### Installation & Binary Setup
The project uses a custom assembly script to fetch the necessary `monero-wallet-rpc` and `tor` binaries for your platform.

```bash
cd desktop
pnpm install
# Binaries are automatically fetched via postinstall/prebuild hooks
```

### Development
```bash
pnpm dev
```

### Build
```bash
pnpm build
```

## 🔐 Security Features
- **Zero-Knowledge Isolation**: Private keys never leave your local encrypted storage.
- **Traffic Sealing**: All outbound RPC calls are forced through the integrated Tor proxy.
- **Graceful Shutdown**: Safety-interceptor to ensure wallet state is saved before process termination.

## 🏗 Maintenance & Release Workflow

This project is maintained as part of the `kyc-rip` ecosystem and synchronized via **Git Subtree**.

### 🔄 Synchronizing with Parent
To push local changes from the parent workspace to this repository:
```bash
git subtree push --prefix desktop git@github-xbtoshi:KYC-rip/ghost-terminal.git main
```

### 🏷 Triggering a Release
The CI pipeline automatically builds and publishes a GitHub Release when a version tag is pushed. **Note:** To ensure the tag points to the correct isolated history of this repository:

1. Create a temporary branch of the subtree:
   ```bash
   git subtree split --prefix desktop -b release-v1.x.x
   ```
2. Tag that branch:
   ```bash
   git tag v1.x.x release-v1.x.x
   ```
3. Push the tag to this repository:
   ```bash
   git push git@github-xbtoshi:KYC-rip/ghost-terminal.git v1.x.x
   ```
4. Cleanup:
   ```bash
   git branch -D release-v1.x.x
   ```

---
**SECURE_UPLINK_ESTABLISHED // NO_LOGS // NO_KYC**
