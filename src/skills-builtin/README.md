# Built-in Skills

Skills loaded by `SkillLoader` at bootstrap (stage 5). Each skill is a
directory `<category>/<name>/` containing:

- `manifest.yaml` — validated by `skillManifestSchema` (see `src/skills/skill-manifest.schema.ts`)
- `index.ts` — exports `default { execute(params, ctx): Promise<ToolResult> }`

Each skill is self-contained (SKILLS-05): `index.ts` either inlines `execute`
(or imports a sibling `<name>.impl.ts`) for read/stop tools, or wires a
`MutationTool` via `mutationExecute(<mutation>)` for the 5 mutation tools
(`create-appointment`, `cancel-appointment`, `reschedule-appointment`,
`waitlist-add`, `send-message`). Mutation business logic lives in
`src/tools/<category>/<name>.mutation.ts`. The legacy `src/tools/**/*.tool.ts`
wrappers and the `ToolRegistry`/`SkillRegistry` pair were removed; the single
canonical store is `UnifiedToolRegistry`, populated at bootstrap stage 5.

External skills can be loaded by pointing `SKILLS_PATH` at a directory
with the same shape. In production, the bootstrap stage requires
`ALLOW_EXTERNAL_SKILLS=true` to honor `SKILLS_PATH` (trusted boundary).
