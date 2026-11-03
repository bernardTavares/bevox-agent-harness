#!/usr/bin/env node
/* eslint-disable */
// ESM migration codemod: adds explicit `.js` extension to relative imports
// in TypeScript source files. Uses Babel AST so it does not touch strings
// or comments that happen to match a regex.
//
// Usage:
//   node scripts/esm-migration-add-extensions.mjs [rootDir]
//
// Default rootDir is `src`. Pass `tests` (or another path) to run over tests.

import { readFileSync, writeFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";
import _generate from "@babel/generator";

const traverse = _traverse.default || _traverse;
const generate = _generate.default || _generate;

const ROOT = resolve(process.argv[2] || "src");

async function* walkTs(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkTs(full);
    else if (entry.isFile() && entry.name.endsWith(".ts")) yield full;
  }
}

function shouldRewrite(importPath, fromFile) {
  // Skip non-relative
  if (!importPath.startsWith(".")) return null;
  // Already has extension
  if (/\.(js|json|mjs|cjs)$/.test(importPath)) return null;

  const base = resolve(dirname(fromFile), importPath);
  // Try as file: ./foo -> ./foo.ts
  try {
    const s = statSync(`${base}.ts`);
    if (s.isFile()) return `${importPath}.js`;
  } catch {
    /* not found */
  }
  // Try as file: ./foo -> ./foo.tsx
  try {
    const s = statSync(`${base}.tsx`);
    if (s.isFile()) return `${importPath}.js`;
  } catch {
    /* not found */
  }
  // Try as directory: ./foo -> ./foo/index.ts
  try {
    const s = statSync(`${base}/index.ts`);
    if (s.isFile()) return `${importPath}/index.js`;
  } catch {
    /* not found */
  }
  // Try as .d.ts (type-only declarations)
  try {
    const s = statSync(`${base}.d.ts`);
    if (s.isFile()) return `${importPath}.js`;
  } catch {
    /* not found */
  }
  return null;
}

let totalChanges = 0;
let filesChanged = 0;

for await (const file of walkTs(ROOT)) {
  const code = readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(code, {
      sourceType: "module",
      plugins: ["typescript", "decorators-legacy"],
    });
  } catch (err) {
    console.error(`[codemod] parse error in ${file}: ${err.message}`);
    continue;
  }
  let changed = false;

  const visitSource = (path) => {
    if (!path.node.source) return;
    const src = path.node.source.value;
    const rewritten = shouldRewrite(src, file);
    if (rewritten) {
      path.node.source.value = rewritten;
      changed = true;
      totalChanges++;
    }
  };

  traverse(ast, {
    ImportDeclaration: visitSource,
    ExportAllDeclaration: visitSource,
    ExportNamedDeclaration: visitSource,
  });

  if (changed) {
    const out = generate(
      ast,
      { retainLines: true, jsescOption: { quotes: "double" } },
      code,
    ).code;
    writeFileSync(file, out, "utf8");
    filesChanged++;
  }
}

console.log(
  `ESM migration: ${totalChanges} imports rewritten across ${filesChanged} files (root: ${ROOT})`,
);
