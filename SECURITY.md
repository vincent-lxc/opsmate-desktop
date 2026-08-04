# Security Policy

## Private disclosure

OpsMate Desktop is a **private** repository during the current stage.

Report suspected vulnerabilities **privately** to the OpsMate maintainers who
own this repository (GitHub organization/user that hosts `opsmate-desktop`).
Do **not** open public GitHub issues or discuss exploit details on public
channels while the project is private.

Preferred channel:

1. Contact the repository owner via a **private** GitHub Security Advisory
   (if enabled) or a direct private message to the maintainers who have write
   access to this repo.
2. Include: affected version/commit, impact summary, reproduction steps, and
   whether secrets or customer data were exposed.
3. Allow a reasonable remediation window before any coordinated disclosure.

## Hard rules (product)

- React / WebView **never** receives OpsMate access/refresh tokens (JWTs).
- Private keys and passphrases **never** enter React state, storage, or logs.
- WebView capabilities stay minimal: **no** generic shell, **no** WebView-exposed
  opener, **no** arbitrary URL fetch proxy IPC.
- Cloud calls use a fixed origin and a checked-in operation allowlist (later tasks).
- `LOGTO_ADMIN_ENDPOINT` (`https://logto-admin.itops.sh`) is **backend-only** and
  must not appear in desktop application code, env samples, or bundles. Naming
  it here as a forbidden item is intentional for auditors.

## Supported versions

Private pre-release builds only. Security fixes target the active development
branch of this repository.
