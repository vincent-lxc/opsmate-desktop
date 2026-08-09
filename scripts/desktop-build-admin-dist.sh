#!/usr/bin/env bash
# Build Admin SPA into apps/admin/dist for the desktop Tauri frontendDist.
# Usage:
#   bash scripts/desktop-build-admin-dist.sh           # real build
#   bash scripts/desktop-build-admin-dist.sh --dry-run # print absolute dist path only
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
ADMIN_DIR="${ROOT}/apps/admin"
DIST_DIR="${ADMIN_DIR}/dist"

if [[ "${1:-}" == "--dry-run" ]]; then
  # Contract: absolute path ending with /apps/admin/dist (Task D1 conf_paths).
  printf '%s\n' "${DIST_DIR}"
  exit 0
fi

cd "${ADMIN_DIR}"
# Desktop privilege UI must talk to production API origin (not empty/same-origin).
export VITE_API_BASE_URL="https://app.itops.sh"
npm run build
