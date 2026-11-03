#!/usr/bin/env bash
set -euo pipefail

TARGET="${CLAUDE_TOOL_FILE_PATH:-}"
case "$TARGET" in
  docs/architecture/openapi.yaml|docs/architecture/openapi.yml) ;;
  src/mcp/*|src/bin/bevox-mcp.ts) ;;
  skills/bevox-agent-harness-consumer/*) ;;
  *) exit 0 ;;
esac

last_msg=$(git log -1 --format=%B 2>/dev/null || echo "")
case "$last_msg" in
  *"BREAKING CHANGE"*|*"feat"*"!"*|*"refactor"*"!"*|*"fix"*"!"*) exit 0 ;;
esac

echo "⚠️  Editou contrato público: $TARGET"
echo "Confirmar se é breaking + bumpar major + ADR + commit 'feat(api)!: ...'"
exit 0
