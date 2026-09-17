import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";

const state = vi.hoisted(() => ({ dir: "", children: [] as ChildProcess[] }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), tmpdir: () => state.dir }));
vi.mock("node:child_process", () => ({
  spawn: vi.fn(() => {
    const proc = new EventEmitter() as ChildProcess & { stdin: any; stdout: any; stderr: any; killed: boolean; exitCode: number | null; kill: any; pid: number };
    proc.stdin = { write: vi.fn(), end: vi.fn() };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.killed = false;
    proc.exitCode = null;
    proc.kill = vi.fn();
    proc.pid = 1000 + state.children.length;
    state.children.push(proc);
    return proc;
  }),
}));

import { spawn } from "node:child_process";
import { spawnClaude } from "../process-manager.js";

let originalTmp: string;
beforeEach(async () => {
  originalTmp = (await vi.importActual<typeof import("node:os")>("node:os")).tmpdir();
  state.dir = mkdtempSync(join(originalTmp, "Fusion owned prompt "));
  state.children.length = 0;
  vi.clearAllMocks();
});
afterEach(() => { rmSync(state.dir, { recursive: true, force: true }); });

function promptPath(callIndex: number): string {
  const args = (spawn as any).mock.calls[callIndex][1] as string[];
  return args[args.indexOf("--append-system-prompt") + 1];
}

it("owns prompt files per spawned child and closes only that child's file", () => {
  const a = spawnClaude("synthetic-model", "A");
  const aPath = promptPath(0);
  const b = spawnClaude("synthetic-model", "B");
  const bPath = promptPath(1);

  expect(aPath).not.toBe(bPath);
  expect(readFileSync(aPath, "utf8")).toBe("A");
  expect(readFileSync(bPath, "utf8")).toBe("B");

  a.emit("close", 0, null);
  expect(existsSync(aPath)).toBe(false);
  expect(readFileSync(bPath, "utf8")).toBe("B");

  b.emit("close", 0, null);
  expect(existsSync(bPath)).toBe(false);
});

it("removes the prompt file when spawn throws synchronously", () => {
  (spawn as any).mockImplementationOnce(() => { throw new Error("synthetic spawn failure"); });
  expect(() => spawnClaude("synthetic-model", "orphan candidate")).toThrow(/synthetic spawn failure/);
  expect(readdirSync(state.dir)).toEqual([]);
});
