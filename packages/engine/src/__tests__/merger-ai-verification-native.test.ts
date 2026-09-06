import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStore } from "@fusion/core";
import { verifyAiMergeCandidate } from "../merge/merger-ai-verification.js";

describe("AI merge verification with real child exits", () => {
  let root: string, base: string, head: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim();
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "fusion merge verification "));
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.com");
    git("config", "core.autocrlf", "false");
    writeFileSync(join(root, "base.txt"), "base\n");
    git("add", "-A"); git("commit", "-qm", "base"); base = git("rev-parse", "HEAD");
    git("checkout", "-qb", "fusion/fixture");
    writeFileSync(join(root, "feature.txt"), "feature\n");
    git("add", "-A"); git("commit", "-qm", "feature"); head = git("rev-parse", "HEAD");
  });
  afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });
  it.each([0, 1])("uses the real command exit %s without advancing main", async (exitCode) => {
    const task = { id: "FIXTURE", branch: "fusion/fixture" };
    const settings = { testCommand: `"${process.execPath}" -e "process.exit(${exitCode})"`, verificationCommandTimeoutMs: 5000 };
    const store = {
      getTask: vi.fn(async () => task), getSettings: vi.fn(async () => settings),
      logEntry: vi.fn(async () => undefined), appendAgentLog: vi.fn(async () => undefined),
    } as unknown as TaskStore;
    const verification = verifyAiMergeCandidate({ store, taskId: task.id, mergeRoot: root,
      branch: task.branch, tipSha: base, squashSha: head, log: async () => undefined });
    if (exitCode) await expect(verification).rejects.toThrow("verification failed: test");
    else await (await verification)();
    expect(git("rev-parse", "main")).toBe(base);
    expect(git("status", "--porcelain")).toBe("");
  });
  it("reports not-run rather than verified when there are no commands", async () => {
    const log = vi.fn(async () => undefined);
    const store = { getTask: async () => ({ id: "FIXTURE", branch: "fusion/fixture" }), getSettings: async () => ({}) } as unknown as TaskStore;
    await verifyAiMergeCandidate({ store, taskId: "FIXTURE", mergeRoot: root,
      branch: "fusion/fixture", tipSha: base, squashSha: head, log });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("not-run"));
  });
});
