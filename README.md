<p align="center">
  <strong>English</strong> | <a href="README.zh-CN.md">简体中文</a>
</p>

<div align="center">
  <a href="https://github.com/vincent-lxc/opsmate-desktop">
    <img src="apps/desktop/src-tauri/icons/icon.png" alt="OpsMate Logo" width="112" height="112">
  </a>

  <h1>OpsMate Desktop</h1>
  <h3>The secure desktop client for OpsMate</h3>
  <p><strong>Local credential vault · Native SSH · Cloud monitoring · AI-assisted diagnostics · High-risk confirmations · Auditable releases</strong></p>
  <p>Keep private keys on your device while connecting monitoring, collaboration, and audit workflows to OpsMate.</p>

  <p>
    <img src="https://img.shields.io/badge/Tauri-2-24C8DB?style=flat-square&logo=tauri&logoColor=white" alt="Tauri 2">
    <img src="https://img.shields.io/badge/Rust-1.92-000000?style=flat-square&logo=rust&logoColor=white" alt="Rust 1.92">
    <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" alt="React 19">
    <img src="https://img.shields.io/badge/macOS-Signed%20%2B%20Notarized-1f8b4c?style=flat-square&logo=apple&logoColor=white" alt="macOS signed and notarized">
    <img src="https://img.shields.io/badge/License-MPL--2.0-orange?style=flat-square" alt="MPL-2.0">
  </p>
</div>

> **Authoritative release source:** `apps/admin` and `apps/desktop` in this repository. Root `src` and `src-tauri` contain legacy history and are not release inputs.

OpsMate Desktop is the independent desktop client for [OpsMate](https://github.com/vincent-lxc/ops-ai). It keeps login sessions, cloud transport, the local credential vault, and local Secure Shell (SSH) connections inside the trusted Rust boundary. The React WebView renders the interface but never receives access tokens, refresh tokens, SSH private keys, or passphrases.

## Contents

[Product scope](#product-scope) · [Current capabilities](#current-capabilities) · [Security and trust boundaries](#security-and-trust-boundaries) · [Credential custody](#credential-custody) · [High-risk operations](#high-risk-operations) · [Auditability](#auditability) · [Architecture](#architecture) · [Downloads and release status](#downloads-and-release-status) · [Local development](#local-development) · [Repository structure](#repository-structure) · [Security reporting](#security-reporting) · [License](#license)

## Product scope

OpsMate Desktop is not an offline copy of the OpsMate SaaS backend or a general-purpose terminal. It gives individuals and teams a controlled desktop environment for managing SSH servers while reusing OpsMate accounts, servers, monitoring, subscriptions, and AI services.

| Requirement | Desktop behavior |
|-------------|------------------|
| Private keys must not enter a browser context | Rust reads keys and passphrases from the local vault; React never receives plaintext |
| Local SSH requires host verification | Rust verifies host keys and requests native confirmation on first trust |
| Unattended patrol requires cloud credentials | OpsMate can run unattended tasks only after you explicitly select cloud custody |
| High-risk actions must resist accidental clicks | Page warnings and native confirmation protect uploads, deletion, and vault reset |
| Client controls must be reviewable | IPC, cloud API contracts, generated code, tests, and release gates have checked-in evidence |

## Current capabilities

Desktop organizes daily work under four top-level surfaces:

| Surface | Capability |
|---------|------------|
| **Monitoring Center** | View OpsMate cloud monitoring data, patrol results, and problem state |
| **My Servers** | View server details and enter the SSH terminal and AI workspace |
| **Credentials** | Manage the local vault and explicitly selected cloud-hosted credentials |
| **My Account** | View account details, Telegram binding, edition entitlements, and subscriptions |

The SSH terminal and AI workspace belong to server detail context. Desktop does not expose a standalone top-level terminal. Visible menus and actions derive from the role and entitlements returned by OpsMate SaaS. Backend API authorization remains authoritative.

### Authentication and sessions

Authentication uses the system browser and Logto Proof Key for Code Exchange (PKCE). The browser returns through `opsmate://auth/callback`. Rust stores and refreshes the session, then injects authorization into requests sent to the fixed cloud origin.

Desktop runs a security cutoff after logout, identity changes, host sleep or lock, or a cloud `401` response:

1. Cancel cloud requests for the affected identity epoch
2. Clear the local session
3. Close local and cloud terminal connections
4. Lock the local vault

### SSH and AI

Rust creates local SSH connections, verifies host keys, and stores confirmed hosts inside the local `known_hosts` boundary. React can invoke named terminal operations but cannot execute a generic shell command.

Before terminal excerpts reach OpsMate AI, Rust processes sensitive field names, common credential patterns, and output size limits. This control reduces accidental disclosure but does not replace your review of the content you send.

## Security and trust boundaries

Desktop treats the WebView as a semi-trusted presentation layer and the Rust process as the trusted local execution boundary.

| Zone | Trust level | Responsibilities |
|------|-------------|------------------|
| React WebView | Semi-trusted | Routing, forms, lists, and presentation state |
| Rust / Tauri | High trust | PKCE, session tokens, local vault, SSH, cloud HTTP/WebSocket, and native confirmations |
| OpsMate SaaS | Cloud service boundary | Accounts, servers, monitoring, subscriptions, AI, approvals, and cloud audit data |
| Logto | External identity provider | Authentication and consent in the system browser |

The client enforces these rules:

- React and the WebView never receive OpsMate access or refresh tokens
- SSH private keys and passphrases never enter React state, Web Storage, or application logs
- The WebView has no generic shell, generic opener, or arbitrary URL request proxy
- Cloud requests allow only `https://app.itops.sh` and `wss://app.itops.sh`
- Every cloud operation must exist in the checked-in operation manifest
- Local credentials stay on the device unless you explicitly request cloud custody
- Failed security checks stop the operation instead of falling back to a weaker path

Read [`THREAT_MODEL.md`](THREAT_MODEL.md) for the complete boundary and threat analysis.

## Credential custody

Local and cloud credentials solve different operational needs. Desktop never synchronizes local private keys to the cloud automatically.

| Mode | Storage | Intended use | Unattended patrol |
|------|---------|--------------|-------------------|
| **Local vault** | Stronghold encrypted vault on the current device | Operator-present SSH and diagnostics | No |
| **Cloud custody** | Controlled OpsMate SaaS credential service | Scheduled patrol, alert handling, and remote collaboration | Yes |

The local vault namespaces material by verified subject, tenant, and credential identifier. Locking the vault clears its unlocked in-memory state without deleting the vault files.

Cloud custody is a separate trust decision. Review credential scope, server permissions, and unattended use before uploading. Use least-privilege accounts and restrict allowed commands on production servers.

## High-risk operations

Desktop uses layered confirmation for operations that change custody or destroy local data.

| Operation | Page confirmation | Native confirmation | Result |
|-----------|-------------------|---------------------|--------|
| Upload a credential to the cloud | Explains the custody change | Required | Cloud tasks may use it unattended |
| Delete a cloud credential | Explains the affected cloud behavior | Required | Related cloud tasks may lose access |
| Delete a local credential | Explains the device-local impact | Follows the operation policy | Removes only the copy on this device |
| Reset the local vault | Shows an irreversible warning | Requires an exact phrase and acknowledgement | Closes terminals and deletes the local vault and salt |

Resetting the local vault does not delete cloud-hosted copies. Credentials that exist only in the local vault cannot be recovered. Desktop never runs this operation in the background.

## Auditability

Auditability covers source boundaries, runtime decisions, and release evidence. Desktop does not invent a second local business audit ledger. OpsMate SaaS remains responsible for audit records associated with cloud business operations.

| Audit surface | Reviewable evidence | Constraint |
|---------------|---------------------|------------|
| WebView IPC | [`desktop-ipc.toml`](apps/desktop/src-tauri/permissions/desktop-ipc.toml) | Allows named commands only, with no generic shell or opener |
| Cloud API | [`desktop-operations.json`](contracts/desktop-operations.json) | One manifest generates Rust, TypeScript, and OpenAPI contracts |
| Contract drift | `npm run contracts:check` | Fails when generated files differ from the manifest |
| High-risk decisions | Page warnings, native dialogs, and confirmation phrases | One WebView click cannot complete critical destructive actions |
| Session invalidation | Rust security cutoff and tests | A `401`, logout, or identity change closes sessions, terminals, and the vault |
| AI outbound content | Rust redaction and size-limit tests | Malformed payloads fail closed instead of being forwarded |
| Release artifacts | [Desktop release workflow](.github/workflows/desktop-release.yml) | Tests, Clippy, signing, notarization, Gatekeeper, and digest gates |

Cloud credential, approval, and remediation audit records depend on the current SaaS API and account entitlements. This repository claims only controls that the desktop client can prove. UI visibility does not prove backend authorization or audit completion.

## Architecture

Desktop separates presentation from trusted execution. Every sensitive operation crosses a named Tauri inter-process communication (IPC) command into Rust.

```text
System browser
    │ Logto PKCE
    ▼
Rust / Tauri host
    ├── session and token custody
    ├── Stronghold local vault
    ├── local SSH transport
    ├── fixed-origin cloud transport
    └── native confirmation
             ▲
             │ named IPC only
             ▼
React WebView
    └── monitoring, servers, credentials, account
```

| Component | Technology and responsibility |
|-----------|-------------------------------|
| Admin UI | React 19, TypeScript 5, Vite 6, and Ant Design |
| Desktop host | Tauri 2, Rust 1.92, Stronghold, and local SSH |
| Cloud transport | Rust HTTP/WebSocket client, fixed origins, and operation allowlist |
| Identity | System-browser Logto PKCE and deep-link callback |
| Tests | Vitest, Rust tests, contract checks, and capability-boundary tests |

This repository is an independent Git project. It does not embed `ops-ai/apps/admin` or `../../admin/dist`. The release frontend builds from this repository's `apps/admin`, and Tauri loads the generated `apps/admin/dist` assets.

## Downloads and release status

macOS pre-releases are available from [GitHub Releases](https://github.com/vincent-lxc/opsmate-desktop/releases). The release pipeline builds a universal DMG for Apple Silicon and Intel, then applies these gates:

1. Install locked dependencies and run frontend tests
2. Verify generated contracts against the source manifest
3. Build the Web frontend
4. Run Rust formatting, strict Clippy, and tests
5. Sign the universal macOS application with Developer ID
6. Submit the DMG for Apple notarization and staple the ticket
7. Run `codesign`, Gatekeeper, and stapler validation
8. Publish the DMG and SHA-256 digest

All `desktop-v*` releases currently belong to the pre-release channel. macOS has signed and notarized artifacts. Public Windows and Linux installers are not available yet. The project does not currently promise a long-term support or general availability channel.

## Local development

Local development requires Node.js 22.22.0 or newer and Rust 1.92.0.

Install dependencies and run frontend checks:

```bash
npm ci
npm test
npm run contracts:check
npm run build:web
```

Run the Rust quality gates:

```bash
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --all-targets --all-features -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml \
  --all-targets -- --test-threads=1
```

Start the Tauri development application:

```bash
npm run dev:tauri
```

Build an installer for the current platform:

```bash
npm run build
```

## Repository structure

```text
apps/
  admin/                   React desktop UI and Desktop bridge
  desktop/                 Tauri application, Rust host, and platform resources
contracts/
  desktop-operations.json  Single source of truth for cloud operations
scripts/
  generate-operations.mjs  Contract generation and drift checks
  desktop-build-admin-dist.sh
.github/workflows/
  desktop-ci.yml
  desktop-release.yml
SECURITY.md
THREAT_MODEL.md
```

## Security reporting

Report vulnerabilities through GitHub Private Vulnerability Reporting or a private Security Advisory for this repository. Do not publish vulnerability details, credentials, or customer data in a public Issue.

Include the following information:

1. Affected version, tag, or commit
2. Impact and affected boundary
3. Reproducible validation steps
4. Whether credentials or customer data were exposed

Read [`SECURITY.md`](SECURITY.md) for the complete reporting process.

## License

OpsMate Desktop uses the [Mozilla Public License 2.0](LICENSE), SPDX identifier `MPL-2.0`.

<div align="center">

**OpsMate Desktop**: Keep credentials local, keep critical actions human-controlled, keep releases auditable.

</div>
