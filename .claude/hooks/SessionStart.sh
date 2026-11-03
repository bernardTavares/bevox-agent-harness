#!/usr/bin/env bash
set -euo pipefail

echo "🧠 bevox-agent-harness — sessão iniciada"
echo "Branch: $(git branch --show-current 2>/dev/null || echo '?')"

echo ""
echo "📌 Gaps relacionados (Wave 7 fecha):"
echo "  - G1: execution_mode + executeOrPropose nas tools de mutação (ADR-006)"
echo "  - G3: account_id → workspace_id UUID (ADR-001/003)"

last_main=$(git merge-base HEAD main 2>/dev/null || echo "")
if [[ -n "$last_main" ]]; then
  changed=$(git diff --name-only "$last_main"..HEAD -- \
    docs/architecture/openapi.yaml \
    src/mcp/ \
    src/bin/bevox-mcp.ts \
    skills/bevox-agent-harness-consumer/ 2>/dev/null || true)
  if [[ -n "$changed" ]]; then
    echo ""
    echo "⚠️  Contratos públicos modificados desde main:"
    echo "$changed" | sed 's/^/  - /'
  fi
fi
