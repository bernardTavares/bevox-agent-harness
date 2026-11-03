---
name: bevox-knowledge-contribute
description: |
  Use whenever the user asks to create, draft, migrate, or update a PRD, ADR,
  architecture document, runbook, spec, roadmap, release note, customer
  feedback artifact, or metrics doc. These artifacts are NOT written to local
  repo paths — they live in bevox-knowledge per ADR-010 (taxonomy) and
  ADR-011 (slots). This skill handles bootstrap, gap-report, migrate,
  propose, and status against the canonical bevox-knowledge slot for
  this project (bevox-harness, slot: bevox-harness).
project: bevox-harness
slot: bevox-harness
bevox_knowledge_path_default: $HOME/bevox-knowledge
helpers_subpath: 99_templates/skill-bevox-knowledge-contribute/lib
version: 1.0.0
---

# bevox-knowledge-contribute (project: bevox-harness)

This project's canonical documentation lives in `bevox-knowledge`,
slot `bevox-harness`. **NEVER** write PRDs, ADRs, architecture docs, specs,
roadmaps, runbooks, release-notes, customer-feedback, or metrics docs
to local repo paths inside bevox-harness.

## Pre-flight (run once per session)

```bash
BK_PATH="${BEVOX_KNOWLEDGE_PATH:-$HOME/bevox-knowledge}"
HELPERS="$BK_PATH/99_templates/skill-bevox-knowledge-contribute/lib"
[ -d "$HELPERS" ] || { echo "skill not installed in $BK_PATH; pull bevox-knowledge"; exit 1; }
```

If `BK_PATH` is not a git repo or helpers are missing, abort and
instruct the user to clone/pull bevox-knowledge before retrying.

## When to activate

- Creating/drafting new canonical doc (PRD, ADR, runbook, etc.)
- Migrating an existing local doc to canonical form
- Reporting what's missing or stale in canonical for bevox-harness
- Diff between local docs and canonical state

## Subcommands

### `bootstrap`

Trigger: "criar slot pra bevox-harness" / first activation.

Steps:
1. `$HELPERS/slot_resolve.sh bevox-harness` → fail-fast if non-canonical
2. For each canonical folder, check if `<bk>/<folder>/bevox-harness/` exists; skip if present (idempotent)
3. Ask user for branch name; default `draft/bevox-harness-bootstrap`
4. `WT=$($HELPERS/git_open_draft.sh <branch>)`
5. For each canonical folder missing the slot dir: `mkdir -p "$WT/<folder>/bevox-harness/" && touch "$WT/<folder>/bevox-harness/.gitkeep"`
6. `$HELPERS/git_commit_push.sh "$WT" "bootstrap(bevox-harness): cria 9 subpastas canônicas"`
7. Print branch URL for review.

### `gap-report` (read-only)

Trigger: "o que tá faltando em bevox-harness?".

Steps:
1. `$HELPERS/slot_resolve.sh bevox-harness` → 9 expected paths
2. For each: `ls` and count artifacts
3. List local docs in `<projeto>/docs/`, `<projeto>/README.md`, `<projeto>/CLAUDE.md`, etc., classifying via `$HELPERS/doc_classify.sh`
4. Identify "implicit decisions" without ADR (env vars, libs grandes, padrões em CLAUDE.md/README sem ADR escrita)
5. Format report: per slot folder, canonical count vs local count, action (MIGRATE / DRAFT FROM SCRATCH / RETIRE), estimated effort

No writes.

### `migrate <source_doc>`

Trigger: "migrar X pra canonical" / "trazer X de bevox-harness/docs/".

Steps:
1. `$HELPERS/doc_classify.sh <source_doc>` → suggested type + confidence
2. Confirm with user (type? naming? renumber if ADR?)
3. Ask branch name; default `draft/bevox-harness-<topic>-migration`
4. `WT=$($HELPERS/git_open_draft.sh <branch>)`
5. Read source, transform (renumber, frontmatter normalization, paths), write to canonical destination
6. `$HELPERS/frontmatter_validate.sh <new_doc> <type>` → on failure, `git -C "$WT" checkout HEAD -- <new_doc>` + surface error
7. `$HELPERS/git_commit_push.sh "$WT" "migrate(bevox-harness/<type>): <source> → <dest>"`
8. Print branch URL.

### `propose <doc_type> <slug>`

Trigger: "vamos criar PRD/ADR/runbook/etc pra bevox-harness".

Steps:
1. Validate `<doc_type>` ∈ {prd, adr, architecture, spec, runbook, roadmap, release-note, customer-feedback, metrics}
2. `$HELPERS/slot_resolve.sh bevox-harness --folder <derived_folder>` → destination dir
3. Apply naming convention (see below) to produce filename
   - For ADR doc_type: NNN comes from `$HELPERS/adr_next_number.sh`
4. Pre-check: if destination file exists, ask user (overwrite? v2? abort?)
5. Ask branch name; default `draft/bevox-harness-<doc_type>-<slug>`
6. `WT=$($HELPERS/git_open_draft.sh <branch>)`
7. Copy `99_templates/<doc_type>.md` → destination, fill placeholders via conversation
8. `$HELPERS/frontmatter_validate.sh <new_doc> <doc_type>`
9. `$HELPERS/git_commit_push.sh "$WT" "propose(bevox-harness/<type>): <slug>"`
10. Print branch URL.

### `status` (read-only)

Trigger: "o que mudou entre bevox-harness local e canonical?".

Steps:
1. List local classifiable docs (`$HELPERS/doc_classify.sh` each)
2. For each, find canonical correspondence (slug or type+heading match)
3. Diff:
   - Absent in canonical → propose migration
   - Absent locally → canonical without clear origin
   - Stale (canonical out-of-date vs local)
4. Format report.

No writes.

## Authority and constraints

- Branch: `draft/bevox-harness-<topic>`, user-supplied; never write to `main`
- Never auto-open PR; print branch URL and let user decide review
- `frontmatter_validate.sh` mandatory before commit (rollback on fail)
- ADR numbering: global sequential — use `$HELPERS/adr_next_number.sh` to get next
- Worktree isolated in `/tmp/bevox-knowledge-worktrees/`; safe to abandon

## Naming conventions

| Doc type | Naming |
|---|---|
| PRD | `<YYYY-MM-DD>-bevox-harness-prd-v<N>.md` |
| ADR | `ADR-<NNN>-<slug>.md` (next available global) |
| Spec | `<YYYY-MM-DD>-<topic>.md` |
| Architecture | `<topic>.md` |
| Runbook | `<verb-noun>.md` (under `20_architecture/bevox-harness/runbooks/`) |
| Release note | `v<X.Y.Z>-<YYYY-MM-DD>.md` |
| Customer feedback | `<YYYY-MM-DD>-<source>-<topic>.md` |
| Metrics | `<metric-name>.md` |
| Inbox | `<YYYY-MM-DD>-<topic>.md` |

## Folder mapping (doc_type → bevox-knowledge folder)

| Doc type | Folder |
|---|---|
| PRD | `10_prd/bevox-harness/` |
| ADR | `30_adr/bevox-harness/` |
| Spec | `35_specs/bevox-harness/` |
| Architecture | `20_architecture/bevox-harness/` |
| Runbook | `20_architecture/bevox-harness/runbooks/` |
| Roadmap | `40_roadmap/bevox-harness/` |
| Release note | `50_releases/bevox-harness/` |
| Customer feedback | `60_customer-feedback/bevox-harness/` |
| Metrics | `70_metrics/bevox-harness/` |
| Inbox | `00_inbox/bevox-harness/` |

## Reference ADRs

- ADR-001 — Company OS Boundary
- ADR-002 — System Topology (amended by ADR-011)
- ADR-005 — Knowledge Source of Truth
- ADR-010 — Knowledge Project Separation
- ADR-011 — Topology amendment (bevox-direct, bevox-meta-api, bevox-site)
- ADR-012 — Meta consumption boundary
