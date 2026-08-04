# Threat Model — OpsMate Desktop (Foundation)

## Trust zones

| Zone | Trust | Components |
|------|-------|------------|
| WebView / React | **Semi-trusted** | UI shell, routing, presentation state. May be compromised via XSS or malicious page content. |
| Rust / Tauri host | **High trust** | Auth PKCE secrets, session tokens, Stronghold vault, local SSH, native openers, cloud HTTP/WSS client. |
| Cloud origin | **Trusted service boundary** | Only `https://app.itops.sh` / `wss://app.itops.sh` (wired in later tasks). |
| IdP | **External** | Public Logto at `https://auth.itops.sh` via **system browser**, never embedded in WebView. |

## Assets

1. OpsMate session / access / refresh tokens
2. SSH private keys and passphrases (local Stronghold)
3. Tenant-scoped server/monitoring data
4. AI terminal excerpts after redaction

## Foundation-stage controls (this scaffold)

- Independent frontend build (`../dist`) — no monorepo `admin/dist` coupling
- CSP `connect-src 'self'` only at foundation (no ad-hoc cloud fetch from WebView)
- Capability file grants `core:default` only — **no** WebView shell / opener plugins
- Product navigation limited to four top-level items: monitoring, servers, credentials, account
- Terminal/AI is contextual under server detail (`/servers/:serverId`), not a top-level menu
- Admin surfaces (roles, users, system, provider, bot config) absent from the shell

## Deferred controls (later tasks)

- Rust-only Logto PKCE + deep link (`opsmate://auth/callback`)
- Fixed-origin allowlisted cloud transport with Authorization injection in Rust
- Stronghold vault namespaced by verified subject + tenant + credential id
- 401 fail-closed: cancel requests, clear session, close SSH, lock vault
- Bundle/source scanners for JWT/PEM/`admin/dist` regressions

## Explicit non-goals of the foundation shell

- Business auth, vault, SSH, or cloud implementations
- Embedding or copying Admin application source
- Exposing generic shell/opener capabilities to the WebView
