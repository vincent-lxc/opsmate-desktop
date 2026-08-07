# macOS and Linux Release with Windows Disabled Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish `desktop-v0.1.1` with a signed and notarized macOS DMG plus Linux AppImage/deb assets while keeping the Windows release job explicitly disabled and absent from the Release.

**Architecture:** Keep the existing Windows job and SignPath configuration intact, but add an explicit always-false job condition so no Windows runner or secrets are used. Change the release dependency graph, artifact downloads, recursive staging, checksum set, and release notes to macOS plus Linux only; strengthen the file-backed validator and tests so the temporary policy is fail-closed and reversible.

**Tech Stack:** GitHub Actions YAML, Node.js ESM validation helpers, Vitest, Tauri 2, Rust 1.92.0, Apple `notarytool`/`stapler`, GitHub CLI.

---

## Context and file map

- Design authority: `docs/superpowers/specs/2026-08-07-macos-linux-release-with-windows-disabled-design.md`
- Workflow behavior: `.github/workflows/desktop-release.yml`
- Pure structural validator: `scripts/check-release-config.mjs`
- Regression and file-backed gates: `tests/security/release-config.test.ts`
- Existing macOS bounded-notarization fix: commit `a57a876`
- Existing stale release run to cancel: `31089833147`
- Existing immutable tag to preserve: `desktop-v0.1.0`
- New tag: `desktop-v0.1.1`

Do not modify `.signpath/policies/opsmate-desktop/release-signing.yml`; Windows signing configuration remains preserved for later restoration. Do not weaken branch CI: the `desktop-ci` macOS, Windows, and Linux checks still run on the implementation branch. Only the protected tag release workflow skips Windows.

### Task 1: Make the release-policy tests describe macOS/Linux-only publication

**Files:**
- Modify: `tests/security/release-config.test.ts:1147-1600`
- Test: `tests/security/release-config.test.ts`

- [ ] **Step 1: Change the happy-path fixture before production code**

In `signedReleaseHappyPathYaml()`, keep the complete Windows job body but make its job-level policy explicit:

```yaml
  windows:
    if: \${{ false }}
    runs-on: windows-2025
```

The backslash is required only inside the TypeScript template literal; the generated YAML still contains `if: ${{ false }}`.

Change the fixture's release graph and artifacts:

```yaml
  release:
    needs: [macos, linux]
```

Remove the Windows `actions/download-artifact` step and remove:

```bash
stage_platform "${ARTIFACT_WINDOWS}"
```

Change the fixture's publish command to carry an explicit release note:

```bash
gh release create "$GITHUB_REF_NAME" \
  --notes "Signed and notarized macOS DMG; Linux AppImage+deb. Windows is not included." \
  --prerelease -- "${files[@]}" SHA256SUMS
```

- [ ] **Step 2: Add policy mutation tests**

Add this test next to the existing structural happy-path test:

```ts
it("requires Windows disabled and excludes Windows from release lineage and assets", () => {
  const valid = signedReleaseHappyPathYaml();
  expect(checkDesktopReleaseWorkflowContent(valid)).toEqual([]);

  const enabledWindows = valid.replace(
    "  windows:\n    if: ${{ false }}\n",
    "  windows:\n",
  );
  expect(
    checkDesktopReleaseWorkflowContent(enabledWindows).some((e) =>
      /windows.*explicitly disabled/i.test(e),
    ),
  ).toBe(true);

  const windowsDependency = valid.replace(
    "needs: [macos, linux]",
    "needs: [macos, windows, linux]",
  );
  expect(
    checkDesktopReleaseWorkflowContent(windowsDependency).some((e) =>
      /needs exactly.*macos.*linux/i.test(e),
    ),
  ).toBe(true);

  const windowsDownload = valid.replace(
    `      - uses: ${REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT}\n        with:\n          name: ${ARTIFACT_LINUX}`,
    `      - uses: ${REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT}\n        with:\n          name: ${ARTIFACT_WINDOWS}\n          path: ${ARTIFACT_WINDOWS}\n      - uses: ${REQUIRED_ACTIONS_DOWNLOAD_ARTIFACT}\n        with:\n          name: ${ARTIFACT_LINUX}`,
  );
  expect(
    checkDesktopReleaseWorkflowContent(windowsDownload).some((e) =>
      /must not download.*windows/i.test(e),
    ),
  ).toBe(true);
});
```

- [ ] **Step 3: Update older three-platform mutations to the selected policy**

Replace test mutations that start from `needs: [macos, windows, linux]` with `needs: [macos, linux]`. Keep SignPath/Authenticode tests unchanged because the dormant Windows configuration must remain valid. Update one-level-glob fixtures so the checksum and publish examples contain only `${ARTIFACT_MACOS}/* ${ARTIFACT_LINUX}/*`.

- [ ] **Step 4: Run RED and confirm the failure is policy-specific**

Run:

```bash
rtk npm test -- tests/security/release-config.test.ts
```

Expected: FAIL because the current validator still requires Windows in `release.needs`, downloads, and recursive staging, and does not require the Windows job to be disabled. Do not edit the workflow yet.

- [ ] **Step 5: Preserve the observed RED state without committing it**

Record the policy-specific failure in the execution notes and proceed directly to Task 2. Do not push or commit a deliberately failing test state.

### Task 2: Teach the validator the explicit Windows-disabled policy

**Files:**
- Modify: `scripts/check-release-config.mjs:1233-1830`
- Test: `tests/security/release-config.test.ts`

- [ ] **Step 1: Add a job-header-only disabled check**

Add the helper immediately before `checkDesktopReleaseWorkflowContent` so a step-level `if: false` cannot spoof the job policy:

```js
/** @param {string} body */
function jobHasExplicitFalseCondition(body) {
  const header = body.split(/^\s*steps\s*:/m)[0];
  return /^\s*if:\s*\$\{\{\s*false\s*\}\}\s*(?:#.*)?$/m.test(header);
}
```

After all four jobs have been extracted, add:

```js
if (!jobHasExplicitFalseCondition(jobs.windows)) {
  errors.push(
    "desktop-release.yml job 'windows' must be explicitly disabled with job-level if: ${{ false }}",
  );
}
```

Continue validating the dormant Windows Node pin, SignPath action pin, secret mappings, unsigned-input lineage, Authenticode check, and signed-output upload. This prevents the preserved restoration path from silently rotting.

- [ ] **Step 2: Require an exact macOS/Linux release graph**

Replace the existing three-platform `needs` requirement with:

```js
const expectedNeeds = new Set(["macos", "linux"]);
if (
  needNames.size !== expectedNeeds.size ||
  [...expectedNeeds].some((name) => !needNames.has(name))
) {
  errors.push(
    "desktop-release.yml job 'release' must declare needs exactly [macos, linux] while Windows is disabled",
  );
}
```

- [ ] **Step 3: Require only retained artifacts and reject Windows leakage**

Define the active artifacts beside release parsing:

```js
const activeReleaseArtifacts = [ARTIFACT_MACOS, ARTIFACT_LINUX];
```

Use `activeReleaseArtifacts` for required downloads and the recursive-stage root check. Require both active roots, collision detection, and `find -type f`, while rejecting any release-job reference to `ARTIFACT_WINDOWS`:

```js
if (rel.includes(ARTIFACT_WINDOWS)) {
  errors.push(
    `desktop-release.yml job 'release' must not download, stage, checksum, or publish disabled Windows artifact ${ARTIFACT_WINDOWS}`,
  );
}
```

Update the stage error to say “both active artifact roots” rather than “all three artifact roots”. Keep the one-level-glob rejection regex aware of all three artifact names so a reintroduced Windows glob also fails.

- [ ] **Step 4: Require honest release notes**

Inside the `gh release create` validation branch, require the publish step to state that Windows is absent:

```js
if (!/Windows is not included/i.test(pub)) {
  errors.push(
    "desktop-release.yml gh release create notes must state that Windows is not included",
  );
}
```

- [ ] **Step 5: Run GREEN for the focused suite**

```bash
rtk npm test -- tests/security/release-config.test.ts
```

Expected: PASS with all release-config tests green.

- [ ] **Step 6: Commit the GREEN tests and validator together**

```bash
rtk git add tests/security/release-config.test.ts scripts/check-release-config.mjs
rtk git commit -m "feat(release): enforce Windows-disabled artifact policy"
```

### Task 3: Apply the policy to the protected tag workflow

**Files:**
- Modify: `.github/workflows/desktop-release.yml:191-477`
- Test: `tests/security/release-config.test.ts`
- Test: `scripts/check-release-config.mjs`

- [ ] **Step 1: Confirm the file-backed gate fails before editing YAML**

```bash
rtk npm test -- tests/security/release-config.test.ts
```

Expected: FAIL in the file-backed `checkDesktopSignedReleaseConfig()` assertion because the real workflow still enables and publishes Windows.

- [ ] **Step 2: Disable Windows before runner allocation**

Change only the Windows job header:

```yaml
  # Temporarily disabled for desktop-v0.1.1; keep the reviewed SignPath path intact.
  windows:
    if: ${{ false }}
    runs-on: windows-2025
    environment: desktop-release
```

- [ ] **Step 3: Remove Windows from the release graph and artifact flow**

Use:

```yaml
  release:
    needs: [macos, linux]
```

Delete the `Download Windows signed` step, remove `stage_platform "opsmate-windows-signed"`, and update the staging comment to “Linux keeps appimage/ + deb/; macOS may nest too”. Do not change the macOS or Linux artifact names.

- [ ] **Step 4: Make the pre-release description explicit**

Use this exact note:

```bash
--notes "OpsMate Desktop pre-release $GITHUB_REF_NAME (signed and notarized macOS DMG; Linux AppImage+deb; Windows is not included)." \
```

- [ ] **Step 5: Run the focused file-backed gate**

```bash
rtk npm test -- tests/security/release-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the workflow change**

```bash
rtk git add .github/workflows/desktop-release.yml
rtk git commit -m "ci(release): publish macOS and Linux without Windows"
```

### Task 4: Run the complete local release verification

**Files:**
- Verify: `.github/workflows/desktop-release.yml`
- Verify: `scripts/check-release-config.mjs`
- Verify: `tests/security/release-config.test.ts`

- [ ] **Step 1: Check formatting and diff scope**

```bash
rtk git diff --check origin/main...HEAD
rtk git status --short
rtk git diff --stat origin/main...HEAD
```

Expected: no whitespace errors; only the approved macOS notarization fix, local credential ignore, design/plan, release validator/tests, and release workflow are present.

- [ ] **Step 2: Run all JavaScript tests and contract verification**

```bash
rtk npm test
rtk npm run contracts:check
rtk npm run build:web
```

Expected: all Vitest tests pass, contract snapshot is unchanged, and the web build exits 0.

- [ ] **Step 3: Run Rust gates with the pinned toolchain**

```bash
rtk cargo +1.92.0 fmt --manifest-path src-tauri/Cargo.toml -- --check
rtk cargo +1.92.0 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
rtk cargo +1.92.0 test --manifest-path src-tauri/Cargo.toml --all-targets --all-features
```

Expected: formatting clean, clippy exits 0 with no warnings, and all Rust tests pass.

- [ ] **Step 4: Confirm the policy directly from the YAML**

```bash
rtk rg -n "windows:|if:.*false|needs:|opsmate-windows-signed|Windows is not included|notarytool|stapler" .github/workflows/desktop-release.yml
```

Expected: Windows is job-disabled; release needs only macOS/Linux; Windows artifact appears only inside the dormant Windows job; explicit notarization and staple gates remain.

### Task 5: Push the implementation branch and require three-platform branch CI

**Files:**
- No new file changes expected.

- [ ] **Step 1: Push the branch**

```bash
rtk git push origin ci/macos-notarization-timeout
```

Expected: remote branch advances through the design, test, validator, and workflow commits.

- [ ] **Step 2: Find and watch the new desktop-ci run**

```bash
rtk gh run list --repo vincent-lxc/opsmate-desktop \
  --branch ci/macos-notarization-timeout \
  --workflow desktop-ci.yml --limit 1 \
  --json databaseId,status,conclusion,headSha,url
```

Resolve and watch the newest run from the just-pushed branch:

```bash
ci_run_id="$(rtk gh run list --repo vincent-lxc/opsmate-desktop \
  --branch ci/macos-notarization-timeout \
  --workflow desktop-ci.yml --limit 1 --json databaseId \
  --jq '.[0].databaseId')"
rtk test -n "$ci_run_id"
rtk gh run watch "$ci_run_id" --repo vincent-lxc/opsmate-desktop --exit-status
```

Expected: macOS, Windows, and Ubuntu branch CI all succeed. Confirm the run head SHA equals the pushed branch HEAD; do not reuse an older green run.

### Task 6: Integrate to main without rewriting `desktop-v0.1.0`

**Files:**
- No new file changes expected.

- [ ] **Step 1: Open a focused pull request**

```bash
rtk gh pr create --repo vincent-lxc/opsmate-desktop \
  --base main \
  --head ci/macos-notarization-timeout \
  --title "ci(release): publish macOS and Linux without Windows" \
  --body "Adds bounded macOS notarization and temporarily disables the Windows tag-release job. The final pre-release contains signed/notarized macOS plus Linux assets only; branch CI remains three-platform."
```

- [ ] **Step 2: Require current PR checks**

```bash
rtk gh pr checks --repo vincent-lxc/opsmate-desktop --watch
```

Expected: required `macos-14`, `windows-2025`, and `ubuntu-24.04` checks pass.

- [ ] **Step 3: Merge with the repository administrator bypass only after checks pass**

The repository requires one review but the owner is the only configured operator. After the checks above are green:

```bash
rtk gh pr merge --repo vincent-lxc/opsmate-desktop --merge --admin
```

Expected: PR merged; no required status check is bypassed. The admin flag bypasses only the unavailable second-person approval.

- [ ] **Step 4: Fetch and verify main contains the release changes**

```bash
rtk git fetch origin main --tags
rtk git merge-base --is-ancestor a57a876 origin/main
rtk git show origin/main:.github/workflows/desktop-release.yml | rtk rg "if:.*false|needs: \[macos, linux\]|Windows is not included"
```

Expected: all commands exit 0. Verify `desktop-v0.1.0` still resolves to commit `4b9b2df717888e1d732b80a0f24eb087415348d1`.

### Task 7: Cancel the stale run and create `desktop-v0.1.1`

**Files:**
- No file changes.

- [ ] **Step 1: Confirm the new tag and Release do not already exist**

```bash
rtk git ls-remote --exit-code --tags origin refs/tags/desktop-v0.1.1
rtk gh release view desktop-v0.1.1 --repo vincent-lxc/opsmate-desktop
```

Expected: both commands report not found. If either exists, stop; never move or overwrite the tag.

- [ ] **Step 2: Cancel the outage-stalled run**

```bash
rtk gh run cancel 31089833147 --repo vincent-lxc/opsmate-desktop
rtk gh run view 31089833147 --repo vincent-lxc/opsmate-desktop --json status,conclusion,url
```

Expected: the stale run becomes completed/cancelled. Do not rerun `desktop-v0.1.0`.

- [ ] **Step 3: Create and push an annotated tag from verified remote main**

```bash
rtk git tag -a desktop-v0.1.1 origin/main -m "OpsMate Desktop v0.1.1 macOS and Linux pre-release"
rtk git push origin refs/tags/desktop-v0.1.1
```

Expected: one new `desktop-release` run is created for `desktop-v0.1.1`.

### Task 8: Approve and monitor the protected macOS/Linux release

**Files:**
- No file changes.

- [ ] **Step 1: Resolve the exact new run ID**

```bash
rtk gh run list --repo vincent-lxc/opsmate-desktop \
  --workflow desktop-release.yml --limit 5 \
  --json databaseId,headBranch,headSha,status,conclusion,url
```

Select only the run whose `headBranch` is `desktop-v0.1.1` and whose `headSha` equals the commit tagged from `origin/main`.

Resolve it without a placeholder:

```bash
release_run_id="$(rtk gh run list --repo vincent-lxc/opsmate-desktop \
  --workflow desktop-release.yml --limit 5 \
  --json databaseId,headBranch \
  --jq 'map(select(.headBranch == "desktop-v0.1.1"))[0].databaseId')"
rtk test -n "$release_run_id"
```

- [ ] **Step 2: Verify Windows is skipped before approval**

```bash
rtk gh run view "$release_run_id" --repo vincent-lxc/opsmate-desktop --json jobs,status,url
```

Expected: Windows is skipped or absent from runner allocation; Linux may run; macOS waits on `desktop-release` approval.

- [ ] **Step 3: Approve the macOS Environment deployment**

```bash
rtk gh api "repos/vincent-lxc/opsmate-desktop/actions/runs/$release_run_id/pending_deployments"
rtk gh api --method POST \
  "repos/vincent-lxc/opsmate-desktop/actions/runs/$release_run_id/pending_deployments" \
  -F 'environment_ids[]=19356317217' \
  -f state=approved \
  -f comment='Approved macOS and Linux v0.1.1 release at user request'
```

Expected: pending deployment list contains only `desktop-release`, current user can approve, and the POST succeeds.

- [ ] **Step 4: Monitor macOS through bounded notarization**

```bash
rtk gh run watch "$release_run_id" --repo vincent-lxc/opsmate-desktop --interval 10
```

Expected macOS sequence: signed Universal DMG build, notarization submission ID, `Accepted`, staple, codesign verification, Gatekeeper assessment, stapler validation, artifact upload. If a step fails, collect that job's failed log and stop; do not blindly rerun.

- [ ] **Step 5: Approve the final Release deployment when it appears**

After both macOS and Linux are successful, repeat the pending-deployments GET and POST from Step 3 for the same run. The second approval starts the `release` job.

- [ ] **Step 6: Require terminal success**

```bash
rtk gh run watch "$release_run_id" --repo vincent-lxc/opsmate-desktop --exit-status
rtk gh run view "$release_run_id" --repo vincent-lxc/opsmate-desktop --json status,conclusion,jobs,url
```

Expected: macOS, Linux, and Release succeed; Windows is skipped; workflow conclusion is success.

### Task 9: Verify the published Release externally

**Files:**
- No repository changes unless a later evidence-document task is explicitly requested.

- [ ] **Step 1: Inspect Release metadata and asset inventory**

```bash
rtk gh release view desktop-v0.1.1 --repo vincent-lxc/opsmate-desktop \
  --json tagName,isPrerelease,isDraft,url,body,assets
```

Expected: pre-release, not draft; notes state Windows is not included; assets include one DMG, AppImage, deb, and `SHA256SUMS`; no `.exe`, `.msi`, NSIS, or `opsmate-windows-signed` asset exists.

- [ ] **Step 2: Download to an isolated temporary directory**

```bash
release_verify_dir="$(rtk mktemp -d /private/tmp/opsmate-desktop-v0.1.1-verify.XXXXXX)"
rtk gh release download desktop-v0.1.1 --repo vincent-lxc/opsmate-desktop --dir "$release_verify_dir"
rtk find "$release_verify_dir" -maxdepth 1 -type f -print
```

Expected: only the declared macOS/Linux files and checksum file are present.

- [ ] **Step 3: Verify checksums and macOS notarization ticket**

```bash
rtk shasum -a 256 -c "$release_verify_dir/SHA256SUMS"
rtk xcrun stapler validate "$release_verify_dir"/*.dmg
rtk spctl --assess --type install --verbose=4 "$release_verify_dir"/*.dmg
```

Expected: every checksum reports `OK`, stapler validation succeeds, and Gatekeeper accepts the downloaded DMG.

- [ ] **Step 4: Report the exact release boundary**

Report the Release URL, tag commit, workflow/run/job conclusions, asset names and sizes, checksum verification result, notarization/Gatekeeper result, and the explicit boundary “Windows is not included”. Do not call it a three-platform release.
