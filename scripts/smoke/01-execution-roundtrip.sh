#!/usr/bin/env bash
# Smoke 01 — execution roundtrip (local dev only).
#
# Wraps scripts/smoke/01-execution-roundtrip.ts so operators can run it
# directly after `pnpm docker:up` without remembering the tsx invocation.
#
# Scope: local dev only. Cluster-level smokes live in the hub repo
# `bevox-PRD-consolidation/scripts/smoke/`.

set -euo pipefail

cd "$(dirname "$0")/../.."

echo "==> Smoke 01: execution roundtrip"
fnm exec --using=v22.22.2 pnpm dlx tsx scripts/smoke/01-execution-roundtrip.ts
echo "==> OK"
