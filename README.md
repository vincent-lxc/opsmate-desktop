# OpsMate Desktop

Independent **private** desktop client for OpsMate (运维助手).

React 19 UI + Tauri 2 / Rust 1.92. Sessions, vault material, and cloud transport
are owned by Rust; the WebView never holds JWTs or private keys.

## Product scope

**Top-level navigation (exactly four)**

- Monitoring Center (监控中心) — `/monitoring`
- My Servers (我的服务器) — `/servers`
- Credentials (凭证) — `/credentials`
- My Account (我的账户) — `/account`

**Contextual (not top-level)**

- Terminal / AI workspace — entered from server detail `/servers/:serverId`
  (placeholder reserved; implemented in a later task)

**Excluded**

- Standalone top-level Terminal/AI menu
- Roles / menu administration
- Tenant user administration
- System management
- Super-admin AI Provider configuration
- Official Telegram Bot configuration

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
npm run dev:tauri   # requires desktop deps; foundation shell only today
rustup run 1.92.0 npm run build
```

## Security docs

- [SECURITY.md](./SECURITY.md) — private disclosure
- [THREAT_MODEL.md](./THREAT_MODEL.md) — trust boundaries
- [NOTICE](./NOTICE) — third-party notices
- [LICENSE](./LICENSE) — All rights reserved (private stage)

## Status

Foundation shell only. Auth, vault, SSH, cloud transport, contracts, and CI land
in subsequent tasks. Do not treat this scaffold as production-ready.
