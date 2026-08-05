# Threat Model — OpsMate Desktop

## Trust zones

| Zone | Trust | Components |
|------|-------|------------|
| WebView / React | **Semi-trusted** | UI shell, routing, presentation state. May be compromised via XSS or malicious page content. |
| Rust / Tauri host | **High trust** | Auth PKCE secrets, session tokens, Stronghold **local vault**, local SSH transport, native openers, cloud HTTP/WSS client. |
| Cloud origin | **Trusted service boundary** | Only `https://app.itops.sh` / `wss://app.itops.sh` (OpsMate **SaaS** backend — not open-sourced by this repo). |
| IdP | **External** | Public Logto at `https://auth.itops.sh` via **system browser**, never embedded in WebView. |

## Assets

1. OpsMate session / access / refresh tokens
2. SSH private keys and passphrases (**local vault** / Stronghold — stay **local by default**)
3. Explicitly selected **cloud-hosted credentials** used for **unattended patrol**
4. Tenant-scoped server/monitoring data from SaaS
5. AI terminal excerpts after redaction (SaaS-assisted features)

## Credential model

- **Local by default:** keys and passwords in the local vault remain on-device; the
  WebView never holds them.
- **Explicit cloud choice:** cloud-hosted credentials are selected by the user and
  enable unattended patrol; they are a distinct trust decision from local vault material.
- **SaaS boundary:** login, account, subscription, monitoring, and AI that depend on
  OpsMate cloud remain proprietary SaaS. Publishing this desktop repository does
  **not** open-source the SaaS backend.

## Implemented controls (current desktop client)

- Independent frontend build (`../dist`) — no monorepo `admin/dist` coupling
- CSP `connect-src 'self'` — no ad-hoc cloud fetch from WebView
- Capability file grants `core:default` only — **no** WebView shell / opener plugins
- Four top-level surfaces: monitoring, servers, credentials, account
- Contextual SSH/AI under server detail (`/servers/:serverId`), not a top-level menu
- Rust-owned Logto PKCE + system browser + deep link (`opsmate://auth/callback`)
- Fixed-origin allowlisted cloud transport with Authorization injection in Rust
- Stronghold vault namespaced by verified subject + tenant + credential id
- Local SSH native transport with fail-closed cancel / close paths
- OS sleep / lock observers that seal vault material when the host sleeps or locks
- 401 fail-closed coordination: cancel requests, clear session, close SSH, lock vault
- Three-platform branch CI for internal-unsigned dmg / nsis / appimage+deb artifacts

## Remaining release gates (not claimed done)

- Public signed/notarized Release workflows (Apple + SignPath)
- Full public-source audit / SBOM publication as a release gate
- Production readiness certification and long-term support channels

## Explicit non-goals

- Embedding or copying Admin application source
- Exposing generic shell/opener capabilities to the WebView
- Claiming that open-sourcing this desktop client open-sources OpsMate SaaS
