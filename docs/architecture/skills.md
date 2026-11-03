# Pluggable Skills (Phase 8)

Skills are the manifest-driven evolution of the `src/tools/` layer.

## Layout

```
src/skills-builtin/
  <category>/
    <skill-name>/
      manifest.yaml   # validated by Zod (skill-manifest.schema.ts)
      index.ts        # default-exports { execute(params, ctx) }
```

`tsc` compiles `src/skills-builtin/**/*.ts` into `dist/skills-builtin/`.
A post-build script (`scripts/copy-skill-manifests.js`) mirrors the
`manifest.yaml` files into the same locations under `dist/` so the
production loader (`node dist/index.js`) can read them.

## Loader

`SkillLoader.loadFromPath(root)` walks `<root>/<category>/<name>/`, reads
each `manifest.yaml`, validates it against `skillManifestSchema`, and
`require()`s the entry module. `createRequire(__filename)` is used so the
same path works under both `tsx` (dev, .ts) and the compiled CommonJS
bundle (prod, .js).

### Security

- Manifest `entry` is a single filename (no `/`, no `..`, no absolute paths) — enforced by Zod **and** rechecked in the loader.
- The resolved entry path must remain inside the skill directory (escape attempts are rejected).
- In production, `SKILLS_PATH` is ignored unless `ALLOW_EXTERNAL_SKILLS=true` is set explicitly. External skills are a **trusted boundary** — operator responsibility.
- `SKILLS_DISABLED=name-a,name-b` skips matching skills at load time.

## V1 scope: metadata-only permissions

`permissions.requires` and `permissions.sideEffects` in the manifest are
**documentary only** in V1. The runtime permission evaluator
(`src/permissions/evaluator.ts`) continues to operate on the existing
3-layer model:

1. Agent static (`denied` + `agentType`)
2. Execution context (unavailable tools + account-level deny)
3. Combined evaluation → `PermissionResult`

V2 will plug the manifest permissions into a 4th evaluator layer
(static analysis at load time + runtime side-effect gating).

## Coexistence with `src/tools/`

During the Phase 8 transition both `ToolRegistry` and `SkillRegistry`
are populated at bootstrap stage 5:

- The 13 built-in skill `index.ts` files re-export `execute` from the
  matching legacy tool in `src/tools/<cat>/<name>.tool.ts`, so behavior
  is preserved bit-for-bit.
- `ToolRegistry` keeps all current consumers (reasoning loop,
  permission evaluator) working unchanged.
- External skills loaded via `SKILLS_PATH` are mirrored into
  `ToolRegistry` so they participate in permissioning and the loop.
- The legacy `src/tools/` tree will be removed in a follow-up PR once
  every call site has migrated to `SkillRegistry`.

## Stop signals

`send-message` and `request-human` are detected as stop signals by
**tool name** in the reasoning engines (`src/reasoning/*.ts`). The skill
manifests preserve those exact names, so no engine code changes.
`ToolResult` is unchanged: `{ success, data?, error?, errorCode?, detail? }`.

## Env vars

| Var | Default | Effect |
|---|---|---|
| `SKILLS_PATH` | unset | Directory of additional skills (same layout). Loaded after built-in. |
| `ALLOW_EXTERNAL_SKILLS` | `false` | Required to honor `SKILLS_PATH` when `NODE_ENV=production`. |
| `SKILLS_DISABLED` | empty | Comma-separated skill names to skip at load. |
| `NODE_ENV` | `development` | Toggles the production gate for `SKILLS_PATH`. |

## Adding a new skill

1. Create `src/skills-builtin/<category>/<name>/manifest.yaml`.
2. Create `src/skills-builtin/<category>/<name>/index.ts` exporting `default { execute(params, ctx) }`.
3. Run `npm run build` — manifest is mirrored to `dist/` automatically.
4. Restart the worker. The bootstrap log reports `<N> skills loaded`.
