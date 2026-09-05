import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { runWorkspaceBin, runPnpm, workspaceRoot } from "./workspace-tools.ts";

test("known workspace tools run without .cmd shell quoting", async () => {
  for (const [tool, workspace] of [["tsc", "core"], ["vite", "dashboard"], ["vitest", "dashboard"]]) {
    await runWorkspaceBin(tool, ["--version"], resolve(workspaceRoot, "packages", workspace));
  }
});

test("unknown tools are refused", async () => {
  await assert.rejects(runWorkspaceBin("unexpected-tool", [], workspaceRoot), /Unsupported workspace tool/);
});

test("pnpm staging preserves spaced paths and shell metacharacters as literal arguments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "Fusion package args "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cli = join(root, "pnpm.cjs");
  await writeFile(cli, "require('node:fs').writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));\n");
  const args = ["deploy", "--prod", join(root, "destination with spaces & literal")];
  await runPnpm(args, root, cli);
  assert.deepEqual(JSON.parse(await readFile(join(root, "argv.json"), "utf8")), args);
});
