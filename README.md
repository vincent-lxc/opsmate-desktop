> **Authoritative release source:** `apps/admin` and `apps/desktop` in this repository. Root `src` and `src-tauri` are legacy history and are not release inputs.

# OpsMate Desktop

Independent **pre-release** desktop client for OpsMate (运维助手).

React 19 UI + Tauri 2 / Rust 1.92. This repository is the **desktop client only**:
sessions (Logto PKCE), cloud transport, local Stronghold vault, and local SSH are
owned by Rust. The WebView never holds JWTs or private keys.

**License:** [Mozilla Public License 2.0](./LICENSE) (SPDX `MPL-2.0`).

## Product scope

**Top-level navigation (exactly four)**

- Monitoring Center (监控中心) — `/monitoring`
- My Servers (我的服务器) — `/servers`
- Credentials (凭证) — `/credentials`
- My Account (我的账户) — `/account`

**Contextual (not top-level)**

- Terminal / SSH and AI workspace — entered from server detail `/servers/:serverId`

**Excluded from this shell**

- Standalone top-level Terminal/AI menu
- Roles / menu administration
- Tenant user administration
- System management
- Super-admin AI Provider configuration
- Official Telegram Bot configuration

## Credentials and trust boundaries

- **Local vault (default):** SSH keys and passwords stored in the local Stronghold
  vault stay **local by default** on the device; they are not uploaded unless the
  user takes an explicit product action that requires otherwise.
- **Cloud-hosted credentials:** when the user **explicitly selects** cloud-hosted
  credentials, those credentials enable **unattended patrol** against managed
  hosts. That path is opt-in, not the default for local private keys.
- **SaaS remains closed:** cloud login/authentication (Logto), account,
  subscription, monitoring data plane, and AI features that call OpsMate cloud
  remain **OpsMate SaaS services** at `https://app.itops.sh` /
  `wss://app.itops.sh`. **Publishing this desktop repository does not open-source
  the SaaS backend.**

## Independence

This repository is **not** a monorepo folder and **does not** embed
`ops-ai/apps/admin` or `../../admin/dist`. The Vite build emits to `dist/`, and
Tauri loads `frontendDist: ../dist`.

## Development

```bash
# JS toolchain
npm ci
npm test
npm run build:web

# Rust / Tauri (use Rust 1.92+)
rustup run 1.92.0 cargo test --manifest-path src-tauri/Cargo.toml
npm run dev:tauri
rustup run 1.92.0 npm run build
```

## Security docs

- [SECURITY.md](./SECURITY.md) — vulnerability reporting (private advisory)
- [THREAT_MODEL.md](./THREAT_MODEL.md) — trust boundaries and controls
- [NOTICE](./NOTICE) — third-party notices
- [LICENSE](./LICENSE) — MPL-2.0

## Status

Pre-release desktop client under active development. Branch CI may produce
**internal-unsigned** installers for engineering use. This repository does **not**
claim production readiness, code signing, notarization, or a public Release
channel for signed binaries.
