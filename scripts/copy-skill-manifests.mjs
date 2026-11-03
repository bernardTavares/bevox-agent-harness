/* eslint-disable */
// Copy `src/skills-builtin/**/manifest.yaml` to `dist/skills-builtin/**/manifest.yaml`.
// `tsc` only emits .js/.d.ts/.js.map — YAML manifests need to be mirrored manually
// so the SkillLoader can find them at runtime in production (`node dist/index.js`).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SRC = path.resolve(__dirname, "..", "src", "skills-builtin");
const DST = path.resolve(__dirname, "..", "dist", "skills-builtin");

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile() && e.name === "manifest.yaml") {
      const rel = path.relative(SRC, full);
      const out = path.join(DST, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.copyFileSync(full, out);
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`[copy-skill-manifests] source missing: ${SRC}`);
  process.exit(0);
}
if (!fs.existsSync(DST)) fs.mkdirSync(DST, { recursive: true });
walk(SRC);
console.log("[copy-skill-manifests] manifests mirrored to dist/skills-builtin/");
