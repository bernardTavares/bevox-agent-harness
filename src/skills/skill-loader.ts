import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";

import yaml from "js-yaml";

import { skillManifestSchema } from "./skill-manifest.schema.js";
import type { LoadedSkill, SkillModule } from "./skill-runtime.js";

export interface SkillLoaderOptions {
  /**
   * Disabled skills by name (set via `SKILLS_DISABLED` env). Skipped at load time.
   */
  disabled?: Set<string>;
}

export class SkillLoader {
  constructor(private opts: SkillLoaderOptions = {}) {}

  /**
   * Load every skill found under `rootDir`. Structure expected:
   *   <rootDir>/<category>/<skill-name>/manifest.yaml
   *   <rootDir>/<category>/<skill-name>/index.{ts,js}
   *
   * Throws on first failure (manifest invalid, entry rejected, etc.) — the
   * bootstrap stage maps this to `process.exit(1)` so misconfigured skill
   * dirs never start the worker.
   */
  async loadFromPath(rootDir: string): Promise<LoadedSkill[]> {
    const absRoot = resolve(rootDir);
    const skills: LoadedSkill[] = [];

    let categories;
    try {
      categories = await readdir(absRoot, { withFileTypes: true });
    } catch (err) {
      throw new Error(`Skills root not found: ${absRoot} (${(err as Error).message})`);
    }

    for (const cat of categories) {
      if (!cat.isDirectory()) continue;
      const catPath = join(absRoot, cat.name);
      const skillDirs = await readdir(catPath, { withFileTypes: true });

      for (const skillDir of skillDirs) {
        if (!skillDir.isDirectory()) continue;
        const skillPath = join(catPath, skillDir.name);
        try {
          const skill = await this.loadSkill(skillPath);
          if (this.opts.disabled?.has(skill.manifest.name)) {
            continue;
          }
          skills.push(skill);
        } catch (err) {
          throw new Error(`Failed to load skill at ${skillPath}: ${(err as Error).message}`);
        }
      }
    }
    return skills;
  }

  private async loadSkill(dir: string): Promise<LoadedSkill> {
    const manifestPath = join(dir, "manifest.yaml");
    const raw = await readFile(manifestPath, "utf8");
    const parsed = yaml.load(raw);
    const manifest = skillManifestSchema.parse(parsed);

    // Reinforced path-safety check on `entry` (Zod already blocks `..` / `/`).
    if (isAbsolute(manifest.entry) || manifest.entry.includes("..")) {
      throw new Error(`Skill ${manifest.name}: entry rejected (path traversal)`);
    }

    // Resolve to .js (compiled, prod) or .ts (dev under tsx). We probe both
    // so the loader is symmetric across `npm start` and `npm run dev`.
    const skillDirAbs = resolve(dir);
    const candidates = [`${manifest.entry}.js`, `${manifest.entry}.ts`, manifest.entry];

    let entryPath: string | undefined;
    for (const candidate of candidates) {
      const full = resolve(skillDirAbs, candidate);
      if (!full.startsWith(skillDirAbs + sep) && full !== skillDirAbs) {
        throw new Error(`Skill ${manifest.name}: entry escaped skill dir`);
      }
      try {
        const s = await stat(full);
        if (s.isFile()) {
          entryPath = full;
          break;
        }
      } catch {
        // try next candidate
      }
    }
    if (!entryPath) {
      throw new Error(
        `Skill ${manifest.name}: entry file not found (looked for ${candidates.join(", ")})`,
      );
    }

    // Dynamic ESM import via file:// URL. Substitui `createRequire(...)(entryPath)`
    // que falhava em prod com `ERR_REQUIRE_ESM` quando os skills compilados são
    // ESM (`export default {...}`) e o runtime é Node 20+. `import()` é
    // universal entre tsx (dev) e `node dist/index.js` (prod).
    const imported = await import(pathToFileURL(entryPath).href);
    const candidate = imported.default ?? imported;

    if (!candidate || typeof candidate.execute !== "function") {
      throw new Error(
        `Skill ${manifest.name} must export default { execute } or { execute } (got ${typeof candidate})`,
      );
    }
    const module: SkillModule = candidate;

    return { manifest, module, manifestPath, skillDir: skillDirAbs };
  }
}
