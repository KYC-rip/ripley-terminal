# GHOST_TERMINAL 🎭

> **Tactical Desktop Terminal for the Monero Ecosystem.**

`ghost-terminal` is a privacy-first, security-hardened desktop application designed for sovereign wealth management. It serves as the local command center for the `kyc-rip` ecosystem, providing direct access to Monero's privacy features with a tactical, terminal-inspired interface.

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

---
**SECURE_UPLINK_ESTABLISHED // NO_LOGS // NO_KYC**
