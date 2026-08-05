# Security Policy

## Reporting a vulnerability

Report security issues through **GitHub Private Vulnerability Reporting** (preferred)
or a **private GitHub Security Advisory** on this repository.

Do **not** open public GitHub issues for vulnerabilities, and do not post exploit
details on public channels before coordinated disclosure.

When reporting, include:

1. Affected version, tag, or commit
2. Impact summary
3. Reproduction steps
4. Whether secrets or customer data were exposed

Allow a reasonable remediation window before any coordinated public disclosure.

## Hard rules (product)

- React / WebView **never** receives OpsMate access/refresh tokens (JWTs).
- Private keys and passphrases **never** enter React state, storage, or logs.
- WebView capabilities stay minimal: **no** generic shell, **no** WebView-exposed
  opener, **no** arbitrary URL fetch proxy IPC.
- Cloud calls use a fixed origin (`https://app.itops.sh` / `wss://app.itops.sh`)
  and a checked-in operation allowlist; Authorization is injected only in Rust.
- Local vault SSH keys and passwords stay **local by default** on the device.
- Explicitly selected **cloud-hosted credentials** are the opt-in path for
  unattended patrol; they are not the default for local private keys.
- Login, account, subscription, monitoring, and AI features that depend on the
  OpsMate cloud remain **SaaS services** at `app.itops.sh`. Publishing this
  desktop repository does **not** open-source the SaaS backend.
- `LOGTO_ADMIN_ENDPOINT` (`https://logto-admin.itops.sh`) is **backend-only** and
  must not appear in desktop application code, env samples, or bundles. Naming
  it here as a forbidden item is intentional for auditors.

## Supported versions

This project ships **pre-release** desktop builds only. Security fixes target the
active development branch and the latest pre-release tags of this repository.
There is no long-term supported GA channel yet; treat all published desktop
artifacts as pre-release unless a future release notes section says otherwise.
