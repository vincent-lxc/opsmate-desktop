---
title: "macOS and Linux release with Windows temporarily disabled"
type: "release-design"
date: "2026-08-07"
status: "design-approved"
---

# macOS and Linux release with Windows temporarily disabled

## Goal

Publish OpsMate Desktop `desktop-v0.1.1` with a signed and notarized macOS DMG plus Linux AppImage and deb assets, while explicitly preventing the Windows job from running. Windows signing configuration remains in the repository for later restoration, but Windows does not consume a runner, block this release, or contribute an artifact.

## Current evidence

- GitHub Actions has recovered from the 2026-08-06 service outage, but release run `31089833147` remains stuck at the run-level queue without a new attempt or approval deployment.
- macOS attempts 1–3 completed the Universal release compilation, then failed while importing the PKCS#12 certificate because its password was wrong.
- macOS attempt 4 imported the certificate and signed the app successfully, then remained inside Tauri's implicit notarization wait until cancellation.
- Commit `a57a876` removes notarization credentials from the Tauri build and introduces explicit submit, bounded wait, staple, codesign, Gatekeeper, and stapler validation steps. Desktop CI passed for this commit, but `desktop-v0.1.0` does not contain it.
- The Windows job currently fails at SignPath and prevents the final multi-platform release job from running.

## Selected approach

Keep the Windows job definition and SignPath configuration, but disable the job with an explicit always-false job condition. Change the final release graph and artifact assembly to contain only macOS and Linux.

This approach is deliberately temporary and reversible. It avoids deleting reviewed Windows signing logic or duplicating the release workflow, while making the absence of a Windows artifact explicit and testable.

## Workflow behavior

The release workflow remains tag-only for `desktop-v*` tags and continues to use the protected `desktop-release` GitHub Environment.

For `desktop-v0.1.1`:

1. `macos` and `linux` run independently.
2. `windows` is skipped before runner allocation through `if: ${{ false }}`.
3. `macos` must complete tests, Universal DMG build, Developer ID signing, explicit Apple notarization, stapling, codesign verification, Gatekeeper assessment, stapler validation, and artifact upload.
4. `linux` must complete its existing tests, AppImage/deb build, and artifact upload.
5. `release` depends only on `macos` and `linux`.
6. `release` downloads only the signed/notarized macOS artifact and Linux artifact, stages their regular files with collision detection, writes `SHA256SUMS`, and publishes them through `gh release create`.
7. No Windows asset, placeholder, unsigned NSIS, or SignPath output is included in the Release.

## Security and failure behavior

- Apple and release credentials remain scoped to the protected Environment.
- No signing or notarization step uses `continue-on-error`.
- A macOS signing, notarization, staple, Gatekeeper, or artifact failure blocks Release publication.
- A Linux build or artifact failure blocks Release publication.
- The disabled Windows job cannot access Environment secrets because it never starts.
- Release publication remains fail-closed: missing artifacts, duplicate staged filenames, or checksum failures stop the job.
- The release description and evidence must state that Windows is not included; it must not imply three-platform availability.

## Test design

Update the file-backed release workflow validator and its tests before changing the workflow.

The regression tests must fail against the current three-platform workflow and then prove that:

- the Windows job still exists but has an explicit always-false job condition;
- the release job depends on exactly macOS and Linux;
- no Windows artifact is downloaded, staged, checksummed, or published;
- macOS retains explicit bounded notarization and all verification steps in order;
- Linux assets and both retained platform artifact names are required;
- forbidden unsigned artifacts and secret interpolation remain rejected.

Run the focused release-config tests first, then the complete JavaScript test suite, contract check, web build, Rust formatting, clippy, and Rust tests before pushing.

## Release procedure

1. Cancel stale run `31089833147` after local verification is green.
2. Commit the workflow and test changes on `ci/macos-notarization-timeout`.
3. Push the branch and require its desktop CI to pass.
4. Integrate the verified commits into `main` without moving or rewriting `desktop-v0.1.0`.
5. Create and push annotated tag `desktop-v0.1.1` from the verified main commit.
6. Approve each new `desktop-release` Environment gate requested by macOS or the final Release job.
7. Monitor the macOS job through notarization acceptance and artifact upload.
8. Verify the GitHub Release assets and `SHA256SUMS` externally before declaring the release ready.

## Rollback

Before GitHub Release creation, cancel the run and leave `desktop-v0.1.1` unpublished. If an incorrect Release is created, mark it unavailable or delete the Release assets only with explicit authorization; do not rewrite an externally consumed tag. Restore Windows later through a reviewed change that removes the false condition, returns Windows to the release dependency graph, restores Windows artifact assembly, and passes the corresponding SignPath gates.

## Acceptance criteria

- Windows receives no runner and contributes no artifact.
- macOS produces a signed, notarized, stapled DMG that passes codesign, Gatekeeper, and stapler validation.
- Linux produces AppImage and deb assets.
- The final GitHub Release contains only the expected macOS/Linux assets and `SHA256SUMS`.
- The release UI and evidence do not claim Windows availability.
- No success is declared until the tag run and external Release asset verification are complete.
