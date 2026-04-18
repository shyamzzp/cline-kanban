#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

echo "[kanban] Installing root dependencies..."
npm install

echo "[kanban] Installing web-ui dependencies..."
npm --prefix web-ui install

echo "[kanban] Building web-ui assets..."
npm run web:build

echo "[kanban] Local install complete."
