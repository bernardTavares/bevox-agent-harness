/**
 * Regression test — Phase B acceptance step 2 (Task B.10).
 *
 * Asserts that the three Phase-B SDR skills auto-discover through the real
 * SkillLoader when pointed at a tree that mirrors `src/skills-builtin/sales`.
 *
 * Strategy: copy the real `sales` skill directories into a temporary root so
 * that Node's `readdir({ withFileTypes: true })` returns genuine `isDirectory()`
 * entries (Windows junctions report `isSymbolicLink`, not `isDirectory`, which
 * the loader's directory-walk would skip). The copied index files still resolve
 * correctly because their only non-type imports are type-erased at runtime.
 */

import os from "node:os";
import path from "node:path";
import { cp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { SkillLoader } from "../../../src/skills/skill-loader.js";
import type { LoadedSkill } from "../../../src/skills/skill-runtime.js";

// __dirname equivalent for ESM/NodeNext
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Absolute path to the real sales category — resolved the same way bootstrap does
const SALES_CATEGORY_SRC = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "src",
  "skills-builtin",
  "sales",
);

const SDR_SKILLS = ["qualify-opportunity", "segment-account", "enrich-3c"] as const;

describe("SDR Phase-B skills auto-discovery via SkillLoader", () => {
  let loaded: LoadedSkill[];
  let tmpRoot: string;

  beforeAll(async () => {
    // Build: <tmpRoot>/sales/<skill-name>/ — real directories so readdir isDirectory() works
    tmpRoot = path.join(os.tmpdir(), `sdr-skill-test-${Date.now()}`);
    const salesDest = path.join(tmpRoot, "sales");
    // fs.cp (Node ≥ 16.7) recursively copies; creates real dirs not junctions
    await cp(SALES_CATEGORY_SRC, salesDest, { recursive: true });

    const loader = new SkillLoader();
    loaded = await loader.loadFromPath(tmpRoot);
  });

  afterAll(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it("discovers exactly the three SDR skills (no extras, no omissions)", () => {
    const names = loaded.map((s) => s.manifest.name).sort();
    expect(names).toEqual([...SDR_SKILLS].sort());
  });

  it.each(SDR_SKILLS)(
    "%s has category === 'sales'",
    (skillName) => {
      const skill = loaded.find((s) => s.manifest.name === skillName);
      expect(skill, `Skill '${skillName}' not found in loaded set`).toBeDefined();
      expect(skill!.manifest.category).toBe("sales");
    },
  );

  it.each(SDR_SKILLS)(
    "%s has agentType === 'surface'",
    (skillName) => {
      const skill = loaded.find((s) => s.manifest.name === skillName);
      expect(skill, `Skill '${skillName}' not found in loaded set`).toBeDefined();
      expect(skill!.manifest.agentType).toBe("surface");
    },
  );

  it.each(SDR_SKILLS)(
    "%s has a valid manifest (name, version, description, entry)",
    (skillName) => {
      const skill = loaded.find((s) => s.manifest.name === skillName);
      expect(skill).toBeDefined();
      const m = skill!.manifest;
      expect(typeof m.name).toBe("string");
      expect(m.name.length).toBeGreaterThan(0);
      expect(typeof m.version).toBe("string");
      expect(m.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof m.description).toBe("string");
      expect(m.description.length).toBeGreaterThan(0);
      expect(typeof m.entry).toBe("string");
      expect(m.entry.length).toBeGreaterThan(0);
    },
  );

  it.each(SDR_SKILLS)(
    "%s exports an execute function",
    (skillName) => {
      const skill = loaded.find((s) => s.manifest.name === skillName);
      expect(skill).toBeDefined();
      expect(typeof skill!.module.execute).toBe("function");
    },
  );
});
