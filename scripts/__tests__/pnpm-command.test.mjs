import test from "node:test";
import assert from "node:assert/strict";
import { resolvePnpmCommand } from "../lib/pnpm-command.mjs";

test("Windows pnpm resolution preserves literal argv", () => {
  const args = ["--filter", "pkg with spaces&metacharacters", "build"];
  const result = resolvePnpmCommand("pnpm", args, {
    platform: "win32", node: "node.exe", resolve: () => "C:\\tools\\pnpm.cjs",
  });
  assert.deepEqual(result, { command: "node.exe", args: ["C:\\tools\\pnpm.cjs", ...args] });
});

test("Windows pnpm resolution uses the installed shim entrypoint when pnpm is global", () => {
  const result = resolvePnpmCommand("pnpm", ["--version"], {
    platform: "win32", node: "node.exe", resolve: () => { throw new Error("not local"); },
    findShim: () => ({ stdout: "C:\\Users\\agent\\AppData\\Roaming\\npm\\pnpm.cmd\r\n" }),
    exists: (value) => value.endsWith("node_modules\\pnpm\\bin\\pnpm.cjs"),
  });
  assert.deepEqual(result, {
    command: "node.exe",
    args: ["C:\\Users\\agent\\AppData\\Roaming\\npm\\node_modules\\pnpm\\bin\\pnpm.cjs", "--version"],
  });
});

test("non-pnpm commands retain their executable and argv", () => {
  assert.deepEqual(resolvePnpmCommand("node", ["file with spaces.js"], { platform: "win32" }), {
    command: "node", args: ["file with spaces.js"],
  });
});

test("Windows pnpm discovery refuses missing, failed, or unavailable entrypoints", () => {
  for (const found of [{status: 1, stdout: "C:\\stale\\pnpm.cmd"},
      {error: new Error("timeout"), stdout: "C:\\stale\\pnpm.cmd"}, {status: 0, stdout: ""},
      {status: 0, stdout: "C:\\missing\\pnpm.cmd"}]) {
    assert.throws(() => resolvePnpmCommand("pnpm", [], {platform: "win32",
      resolve: () => { throw new Error("not local"); }, findShim: () => found, exists: () => false}),
    /discovery failed|entrypoint is unavailable/);
  }
});
