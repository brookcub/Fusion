import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), tmpdir: () => state.dir }));
import { buildClaudeSpawnArgs, cleanupSystemPromptFile } from "../process-manager.js";

let originalTmp: string;
beforeEach(async () => {
  originalTmp = (await vi.importActual<typeof import("node:os")>("node:os")).tmpdir();
  state.dir = mkdtempSync(join(originalTmp, "Fusion real prompt "));
});
afterEach(() => { rmSync(state.dir, { recursive: true, force: true }); });

const pathOf = (args: string[]) => args[args.indexOf("--append-system-prompt") + 1];

it("control: a single prompt is stored exactly and normal cleanup removes it", () => {
  const args = buildClaudeSpawnArgs("synthetic-model", "single prompt");
  expect(readFileSync(pathOf(args), "utf8")).toBe("single prompt");
  cleanupSystemPromptFile();
  expect(readdirSync(state.dir)).toEqual([]);
});

it("control: no prompt does not create a file", () => {
  const args = buildClaudeSpawnArgs("synthetic-model");
  expect(args).not.toContain("--append-system-prompt");
  expect(readdirSync(state.dir)).toEqual([]);
});

it("starting session B cannot replace session A's unread prompt bytes", () => {
  const a = buildClaudeSpawnArgs("synthetic-model", "session A contents");
  const aPath = pathOf(a);
  expect(readFileSync(aPath, "utf8")).toBe("session A contents");
  const b = buildClaudeSpawnArgs("synthetic-model", "session B contents");
  expect(readFileSync(pathOf(b), "utf8")).toBe("session B contents");
  expect(readFileSync(aPath, "utf8"), "session A must still read its own prompt").toBe("session A contents");
});
