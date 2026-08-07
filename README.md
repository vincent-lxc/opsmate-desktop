# OpsMate Desktop (release orchestrator)

Public **release repository** for the OpsMate desktop client. This tree owns
CI/release workflows, signing policy, contracts gates, and the immutable
product **source lock** — not the live product Web UI or Tauri application
sources that ship in installers.

**Product code** lives in [`vincent-lxc/opsmate`](https://github.com/vincent-lxc/opsmate)
and is pinned by [`release/source-lock.json`](./release/source-lock.json)
(`repository` + full 40-hex `commit` only).

**License:** [Mozilla Public License 2.0](./LICENSE) (SPDX `MPL-2.0`).

## Canonical product build (Task 12)

Branch CI (`.github/workflows/desktop-ci.yml`) and signed release
(`.github/workflows/desktop-release.yml`) both:

1. Checkout **this** orchestrator repository.
2. Run orchestrator gates (`npm ci`, `npm test`, `contracts:check`).
3. Read `release/source-lock.json` via `node scripts/read-source-lock.mjs`.
4. Checkout `vincent-lxc/opsmate` at the locked commit into `source/` using
   `secrets.OPSMATE_SOURCE_TOKEN` with `persist-credentials: false` (**build jobs only**).
5. Build and test **only** under:
   - `source/apps/admin` — Admin Web UI (`npm test`, `npm run build`)
   - `source/apps/desktop` — Tauri/Rust desktop (`cargo` + `npm run tauri -- build …`)

Root `src/`, root `src-tauri/`, and root `npm run build:web` are **not** product
inputs. The independent shell that remains in this repo supports historical
contracts/icons/config gates only; installers published by CI/release come from
the locked monorepo paths above.

macOS release keeps Developer ID import (via env), explicit `notarytool`
submit/wait, staple, codesign, Gatekeeper (`spctl --type install`), and
`stapler validate`. Windows remains **job-level** `if: ${{ false }}` and is
excluded from release `needs` and assets. Build jobs export locked source
`repository`/`commit` as job outputs; the **checkout-free** `release` publish
job (`contents: write`) never holds product source tokens and only consumes
`needs.macos` / `needs.linux` outputs for summary and release notes.

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

## Source lock

```json
{
  "repository": "vincent-lxc/opsmate",
  "commit": "<40-char lowercase SHA>"
}
```

Validate / emit Actions outputs:

```bash
node scripts/read-source-lock.mjs
node scripts/check-release-config.mjs
```

## Orchestrator development

```bash
# JS toolchain (release-config / contracts gates)
npm ci
npm test
npm run contracts:check
```

## Security docs

- [SECURITY.md](./SECURITY.md) — vulnerability reporting (private advisory)
- [THREAT_MODEL.md](./THREAT_MODEL.md) — trust boundaries and controls
- [NOTICE](./NOTICE) — third-party notices
- [LICENSE](./LICENSE) — MPL-2.0

## Status

Release orchestration under active development. Branch CI may produce
**internal-unsigned** installers built from the locked product commit. Public
`desktop-v*` tags run the protected signed/notarized macOS path (Windows off).
