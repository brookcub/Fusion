import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings, Task } from "@fusion/core";
import { findAdvancedReviewBase, reconcileResumeReviewBase } from "../executor/reconcile-resume-review-base.js";
import { probeReviewDiffFingerprint } from "../worktree/review-diff-fingerprint.js";
vi.mock("../executor/execute-workflow-graph.js", () => ({ getActivePrincipalHoldCooldown: () => undefined }));
import { executeCore } from "../executor/execute-core.js";

// FNXC:ResumedReviewBase 2026-09-05-11:30: native Git history, no live runtime.
const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(adopt = true, large = false) {
  const dir = mkdtempSync(join(tmpdir(), "fusion review base spaced ")); directories.push(dir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", windowsHide: true }).trim();
  git("init", "--quiet", "--initial-branch=integration");
  git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@localhost");
  git("config", "core.autocrlf", "false");
  const commit = (file: string, content: string, message: string) => {
    writeFileSync(join(dir, file), content); git("add", file); git("commit", "--quiet", "-m", message);
  };
  // Build real objects in one Git process: native process startup dominates Windows fixtures.
  const data = (value: string) => `data ${Buffer.byteLength(value)}\n${value}\n`;
  const entry = (branch: string, mark: number, message: string, ancestry: string, file?: string, contents?: string) =>
    `commit refs/heads/${branch}\nmark :${mark}\ncommitter Fixture <fixture@localhost> 1700000000 +0000\n${data(message)}${ancestry}${file ? `M 100644 inline ${file}\n${data(contents!)}` : ""}\n`;
  const history = entry("integration", 1, "initial", "", "initial.txt", "initial\n")
    + entry("fusion/TEST-1", 2, "TEST-1: task implementation", "from :1\n", "ticket.txt", "ticket\n")
    + entry("integration", 3, "upstream change", "from :1\n", "upstream.txt", large ? "x".repeat(11 * 1024 * 1024) + "\n" : "upstream\n")
    + (adopt ? entry("fusion/TEST-1", 4, "adopt upstream", "from :2\nmerge :3\n", "upstream.txt", large ? "x".repeat(11 * 1024 * 1024) + "\n" : "upstream\n") : "");
  execFileSync("git", ["fast-import", "--quiet"], { cwd: dir, input: history, windowsHide: true });
  const [old, current] = git("rev-parse", "integration^", "integration").split(/\r?\n/);
  git("checkout", "--quiet", "fusion/TEST-1");
  const settings = { integrationBranch: "integration", enginePaused: false } as Settings;
  let live = { id: "TEST-1", column: "in-review", worktree: dir, branch: "fusion/TEST-1", baseCommitSha: old,
    steps: [{ status: "done" }], workflowStepResults: [{ workflowStepId: "plan-review", status: "passed" }] } as unknown as Task;
  const store = {
    getTask: vi.fn(async () => live), getSettings: vi.fn(async () => settings), getBranchGroup: vi.fn(async () => null),
    updateTaskAtomic: vi.fn(async (_id: string, updater: (t: Task) => Promise<Partial<Task> | null>) => {
      const patch = await updater(live); if (patch) live = { ...live, ...patch }; return live;
    }),
  };
  return { dir, git, commit, old, current, settings, store, task: () => live };
}

describe("resumed review input base", () => {
  it("outer dispatch excludes adopted upstream without losing ticket progress or proof", async () => {
    const f = fixture(true, true);
    expect(await probeReviewDiffFingerprint(f.dir, f.old)).toEqual({ state: "unavailable", reason: "git-diff-too-large" });
    const original = f.task(); const graph = vi.fn(async () => {});
    await executeCore({ rootDir: f.dir, store: f.store, graphRouting: new Set(), completionFinalizedTaskIds: new Set(),
      releaseSemaphore: vi.fn(), clearStalePauseAbortBeforeDispatch: vi.fn(async () => {}),
      blockOuterDispatchWhenDependenciesUnmet: vi.fn(async () => false),
      blockOuterDispatchWhenFileScopeLeaseHeld: vi.fn(async () => false), executeWorkflowGraph: graph,
    } as never, original);
    expect(f.task().baseCommitSha).toBe(f.current);
    expect(f.task().steps).toEqual(original.steps); expect(f.task().workflowStepResults).toEqual(original.workflowStepResults);
    expect(f.task().branch).toBe(original.branch); expect(f.task().worktree).toBe(original.worktree);
    expect(graph).toHaveBeenCalledWith(f.task(), { alreadyClaimed: true });
    expect((await probeReviewDiffFingerprint(f.dir, f.current)).state).toBe("fingerprint");
  }, 30000);

  it("preserves the old base when integration advanced but was not incorporated", async () => {
    const f = fixture(false);
    expect(await findAdvancedReviewBase(f.dir, f.old, "integration", "TEST-1")).toBeUndefined();
  });
  it("does not replace missing or invalid history with HEAD", async () => {
    const f = fixture();
    expect(await findAdvancedReviewBase(f.dir, f.old, "missing-target", "TEST-1")).toBeUndefined();
    expect(await findAdvancedReviewBase(f.dir, "a".repeat(40), "integration", "TEST-1")).toBeUndefined();
  });
  it("does not swallow completed task evidence when HEAD is already integrated", async () => {
    const f = fixture(); f.git("branch", "--force", "integration", "HEAD");
    expect(await findAdvancedReviewBase(f.dir, f.old, "integration", "TEST-1")).toBeUndefined();
  });
  it("refuses a checkout on another branch", async () => {
    const f = fixture(); f.git("checkout", "--quiet", "-b", "different-branch");
    expect(await reconcileResumeReviewBase(f.store as never, f.dir, f.task(), f.settings)).toEqual(f.task());
    expect(f.store.updateTaskAtomic).not.toHaveBeenCalled();
  });
  it("preserves base when paused while Git proof is being computed", async () => {
    const f = fixture(); f.store.getSettings.mockResolvedValue({ ...f.settings, enginePaused: true });
    await reconcileResumeReviewBase(f.store as never, f.dir, f.task(), f.settings);
    expect(f.task().baseCommitSha).toBe(f.old);
  });
  it("preserves task-attributed commits already in the advanced integration range", async () => {
    const f = fixture(false); f.git("checkout", "--quiet", "integration");
    f.commit("owned.txt", "owned\n", "fix(test-1): previously landed partial work");
    f.git("checkout", "--quiet", "fusion/TEST-1"); f.git("merge", "--quiet", "--no-edit", "integration");
    expect(await findAdvancedReviewBase(f.dir, f.old, "integration", "TEST-1")).toBeUndefined();
  });
  it("refuses project pause at the final patch boundary", async () => {
    const f = fixture();
    f.store.getSettings.mockResolvedValueOnce(f.settings).mockResolvedValue({ ...f.settings, enginePaused: true });
    await reconcileResumeReviewBase(f.store as never, f.dir, f.task(), f.settings);
    expect(f.task().baseCommitSha).toBe(f.old);
  });
  it("refuses a same-commit checkout switch during the atomic recheck", async () => {
    const f = fixture();
    f.store.getSettings.mockImplementationOnce(async () => {
      f.git("checkout", "--quiet", "-b", "different-branch"); return f.settings;
    });
    await reconcileResumeReviewBase(f.store as never, f.dir, f.task(), f.settings);
    expect(f.task().baseCommitSha).toBe(f.old);
  });
  it("uses the shared group destination instead of the project default", async () => {
    const f = fixture(); f.git("branch", "group-review", f.current);
    f.git("branch", "--force", "integration", f.old);
    f.task().branchContext = { assignmentMode: "shared", groupId: "fixture-group" } as Task["branchContext"];
    f.store.getBranchGroup.mockResolvedValue({ id: "fixture-group", branchName: "group-review", status: "open" } as never);
    await reconcileResumeReviewBase(f.store as never, f.dir, f.task(), f.settings);
    expect(f.task().baseCommitSha).toBe(f.current);
  });
});
