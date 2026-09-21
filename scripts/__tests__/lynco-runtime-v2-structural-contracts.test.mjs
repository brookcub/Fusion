import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p) => readFileSync(resolve(root,p),"utf8");

test("F33: dashboard omitted port consults persisted daemonPort before 4040", () => {
  const source = read("packages/cli/src/bin.ts");
  assert.match(source, /GlobalSettingsStore/);
  assert.match(source, /daemonPort\s*\?\?\s*4040/);
});

test("F25: reconciler always prepends the vendored Claude adapter", () => {
  const source = read("packages/core/src/plugins/pi-extensions.ts");
  const start = source.indexOf("export function reconcileClaudeCliPaths");
  assert.notEqual(start, -1);
  const body = source.slice(start, start + 1400);
  assert.match(body, /p\s*!==\s*vendoredPath/);
  assert.match(body, /return\s+\[vendoredPath,\s*\.\.\.filtered\]/);
  assert.doesNotMatch(body, /if\s*\(!filtered\.includes\(vendoredPath\)\)/);
});

test("F25: daemon, serve, and dashboard share one CLI extension finalizer", () => {
  for (const p of [
    "packages/cli/src/commands/daemon.ts",
    "packages/cli/src/commands/serve.ts",
    "packages/cli/src/commands/dashboard.ts",
  ]) {
    assert.match(read(p), /finalizeCliExtensionPaths/, p);
  }
});
