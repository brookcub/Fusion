import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { runWorkspaceBin, workspaceRoot } from "./workspace-tools.ts";

test("known workspace tools run without .cmd shell quoting", async () => {
  for (const [tool, workspace] of [["tsc", "core"], ["vite", "dashboard"], ["vitest", "dashboard"]]) {
    await runWorkspaceBin(tool, ["--version"], resolve(workspaceRoot, "packages", workspace));
  }
});

test("unknown tools are refused", async () => {
  await assert.rejects(runWorkspaceBin("unexpected-tool", [], workspaceRoot), /Unsupported workspace tool/);
});
