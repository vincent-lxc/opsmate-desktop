# Public-release dependency audit (desktop)

**Date:** 2026-08-05  
**Repo:** `opsmate-desktop` (`feat/secure-desktop-foundation`)  
**Scope:** npm production dependencies, Cargo.lock transitive tree, secret-scan classification, local toolchain pin.  
**Method (commands re-run this pass):**  
- `npm audit --omit=dev --audit-level=high --registry https://registry.npmjs.org/`  
- `cargo +1.92.0 update` / exact pin edits in `src-tauri/Cargo.toml`  
- OSV-Scanner **v2.4.0**: `osv-scanner -L package-lock.json -L src-tauri/Cargo.lock`  
- Gitleaks **v8.30.1** full-history (coordinator-reported scan classification; see below)  
**Honesty:** Targeted pre-publication audit — **not** a whole-security-scan clean claim and **not** “zero findings.”

## Runtime alignment (Node / CI)

`react-router@8.3.0` declares `engines.node: ">=22.22.0"`. The desktop package and CI must match that floor exactly in installers and workflows:

| Surface | Requirement | Value in tree |
|---------|-------------|----------------|
| `package.json` `engines.node` | Floor matching react-router | `>=22.22.0` |
| `package-lock.json` root package `engines.node` | Same floor (regenerated via official registry) | `>=22.22.0` |
| `.github/workflows/desktop-ci.yml` | Exact `setup-node` pin (all jobs) | `node-version: "22.22.0"` |
| `.github/workflows/desktop-release.yml` | Exact pin on macos / windows / linux jobs | `node-version: "22.22.0"` (×3) |
| `scripts/check-release-config.mjs` | `REQUIRED_NODE_VERSION` + reject Node 20 / wrong pin | `22.22.0` |
| GH Actions supply-chain (Task 10C/10D) | Full 40-hex SHAs (not floating tags) | checkout/setup-node/upload-artifact **v7**; cache **v6**; download-artifact **v8.0.1** (release) |

**Decision:** Do **not** run app install/build on Node 20. Node 20 fails `engines` for react-router 8.3 and is rejected by release-config checks and security tests. **Also** do not leave official `actions/*` on floating or Node-20-era pins: CI run **31024328981** annotated that checkout/setup-node/cache/upload-artifact `@v4` target deprecated Node 20 action runtimes. Task **10D** closed the release-only gap: tag aggregator uses `actions/download-artifact` (not exercised on branch CI) and must pin official **v8.0.1** (`using: node24`).

| Action | Major / tag | Full SHA | Workflows |
|--------|-------------|----------|-----------|
| `actions/checkout` | v7 | `3d3c42e5aac5ba805825da76410c181273ba90b1` | CI + release |
| `actions/setup-node` | v7 | `820762786026740c76f36085b0efc47a31fe5020` | CI + release |
| `actions/cache` | v6 | `55cc8345863c7cc4c66a329aec7e433d2d1c52a9` | CI + release |
| `actions/upload-artifact` | v7 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` | CI + release |
| `actions/download-artifact` | **v8.0.1** (`using: node24`) | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` | **release only** (required presence) |

App `node-version: "22.22.0"` input is unchanged (engines floor). Action *runtime* Node 24 is separate from application Node.

## Final lock / pin evidence (from this tree)

| Item | Command / source | Value |
|------|------------------|--------|
| `react-router` | `package.json` / lock | **8.3.0** direct; **no** `react-router-dom` |
| `Node` / `engines` | `package.json` / workflows | **>=22.22.0** package floor; workflows **exact 22.22.0** |
| `anyhow` | `Cargo.toml` / lock | **=1.0.103** |
| `serde` | `Cargo.toml` / lock | **=1.0.228** (coordinated bump from 1.0.219) |
| `serde_json` | `Cargo.toml` / lock | **=1.0.145** |
| `serde_with` | `Cargo.lock` (transitive) | **3.21.0** (was 3.1.0) |
| `time` | `Cargo.lock` (transitive) | **0.3.47** (was 0.3.44) |
| `quick-xml` | `Cargo.lock` | **0.38.4** and **0.41.0** both present |
| `plist` | `Cargo.lock` | **1.8.0** → depends on **quick-xml 0.38.4** |
| `wayland-scanner` | `Cargo.lock` | **0.31.11** → depends on **quick-xml 0.41.0** |
| Toolchain | `rust-toolchain.toml` | `channel = "1.92.0"`, components `rustfmt`/`clippy` only (no forced cross targets; CI installs targets per platform) |

Evidence extract (lock parents for quick-xml):

```text
plist@1.8.0 depends on quick-xml 0.38.4
wayland-scanner@0.31.11 depends on quick-xml 0.41.0
```

## Remediated (fixable / direct)

| Finding | Prior | Decision | Evidence |
|---------|-------|----------|----------|
| `react-router-dom` 7.x advisories | Direct `react-router-dom@7.18.2` | **Removed.** Direct `react-router@8.3.0`. App imports from `react-router` (`BrowserRouter` is package-root in v8.3 types). No unstable RSC usage. | `package.json`, lock (no `node_modules/react-router-dom`), `src/**` imports |
| `anyhow` advisory (fixed ≥ 1.0.103) | `=1.0.97` | **Updated** to `=1.0.103` | `Cargo.toml`, lock |
| `time` 0.3.44 (fixed 0.3.47) | Blocked by serde 1.0.219 | **Updated** after coordinated `serde`/`serde_json` exact-pin bump | lock `time 0.3.47` |
| `serde_with` 3.1.0 (scanner fixed 3.21.0) | Transitive | **Updated** lock to **3.21.0** | lock |
| Toolchain drift | No root pin / optional multi-target list | **Root** `rust-toolchain.toml` **components-only** (`1.92.0` + rustfmt/clippy); CI still adds platform targets | `rust-toolchain.toml` |

### Coordinated pin notes (`time` / `serde_with`)

1. `cargo update -p time --precise 0.3.47` **failed** while `serde = "=1.0.219"` was locked (`serde_derive` 1.0.220 conflict).  
2. Minimal coordinated bump: `serde = "=1.0.228"`, `serde_json = "=1.0.145"` in `Cargo.toml`, then `cargo update -p time --precise 0.3.47` and `cargo update -p serde_with --precise 3.21.0` **succeeded**.  
3. Full `cargo +1.92.0` fmt/clippy/test required after this pass (see verification).

## Residual / deferred (reachability)

### quick-xml (advisory on **0.38.4** only in OSV this pass)

- **Vulnerable line in OSV output:** `quick-xml **0.38.4**` (RUSTSEC-2026-0194 / 2026-0195; scanner “fixed version” 0.41.0).  
- **Also in lock (not flagged this OSV run):** `quick-xml **0.41.0**` via `wayland-scanner 0.31.11` (Linux/Wayland build tooling path).  
- **Vulnerable consumer path:** `plist **1.8.0**` → `quick-xml **0.38.4**` (Tauri/plist packaging, not direct app dep).  
- **First-party code:** No `src-tauri/src` parse of untrusted XML via `quick-xml`.  
- **Decision:** Accept residual until Tauri/plist publish a patched `plist` that no longer needs 0.38.4. Do **not** claim the tree is “only 0.41.x.”

### Deprecated GTK / Linux UI crates (RUSTSEC-2024-041x, glib, etc.)

- Linux WebKit/GTK Rust bindings; often **no fixed crate version**.  
- Host image package hygiene on Ubuntu 24.04; not silent false-clean.

### Other OSV residuals (examples)

`bincode`, `rsa`, `paste`, `proc-macro-error`, `unic-*`, `rustls-pemfile` — transitive/build; re-evaluate on next Tauri pin refresh. **Not** claimed fixed.

## Secret scan — Gitleaks v8.30.1 full history

| Field | Value |
|-------|--------|
| Tool | **Gitleaks v8.30.1** |
| Scope | Full git history |
| Commits scanned | **28** |
| Private-key findings | **5** |

### Classification (all five)

All five were **verified non-production test fixtures** — intentional public test keys, **not** operational credentials:

| Location / surface | Role |
|--------------------|------|
| `src-tauri/src/vault/tests.rs` | Vault unit-test key material |
| `local_ssh` **connect** tests | Intentional SSH test fixtures |
| `local_ssh` **transport** tests | Intentional SSH transport fixtures |
| Upstream **russh** encrypted fixture (used via tests) | Public library test key material |

**No operational credential evidence** (no live customer/CI/environment secrets identified in these hits).

### Decisions

- **No** broad Gitleaks allowlists.  
- **No** fixture deletion solely to silence scanners.  
- **No** history rewrite for “credential revocation” — **not required**, because these are intentional public test keys (nothing operational to rotate).  
- **Do not claim zero secret-scan findings.** Scanners will keep reporting private-key patterns at these paths; treat as expected fixture noise after path verification.

## OSV / npm scan (final this pass)

| Scanner | Scope | Outcome |
|---------|--------|---------|
| `npm audit --omit=dev --audit-level=high` | Production npm | **0 vulnerabilities** (react-router 8.3.0; no react-router-dom) |
| OSV-Scanner **v2.4.0** | `package-lock.json` + `Cargo.lock` | **npm: clean in report.** **Cargo: residuals remain** (see counts). |

### OSV-Scanner v2.4.0 final counts (post time/serde_with fix)

Command: `osv-scanner -L package-lock.json -L src-tauri/Cargo.lock` (v2.4.0).

- Packages scanned (scanner): lockfile package counts **220** (npm) / **726** (Cargo).  
- **Total: 22 packages affected by 23 known vulnerabilities** (0 Critical, **2 High**, **2 Medium**, 0 Low, 19 Unknown) from **1 ecosystem (crates.io)**.  
- Scanner “can be fixed”: **3** (not all actionable without Tauri/plist upgrades).  
- **Notable remaining High:** `quick-xml 0.38.4` (two RUSTSEC entries).  
- **No longer listed after pin updates:** `time 0.3.44`, `serde_with 3.1.0` (cleared by this pass).

**Do not claim zero OSV findings.**

## Non-claims

- No whole-security-scan clean bill of health.  
- No zero Gitleaks / OSV residual claims.  
- No automatic SignPath import or production readiness claims from this document.

## Follow-ups

1. Re-run npm audit + OSV + Gitleaks on every release candidate.  
2. Track Tauri/`plist` for `quick-xml 0.38.4` elimination.  
3. Keep Ubuntu CI host packages patched for GTK/WebKit.  
4. Re-verify any new private-key hits remain test-only (no allowlist expansion without review).
