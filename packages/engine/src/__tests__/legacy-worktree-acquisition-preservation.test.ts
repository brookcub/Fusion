/* FNXC:LegacyWorktreePreservation 2026-09-06-01:12:
 * A naming-policy change must not orphan a resumed task's registered checkout.
 * Native Git proves assignment, registration, and bytes through acquisition failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireTaskWorktree } from "../worktree/worktree-acquisition.js";
import { scanIdleWorktrees } from "../worktree/worktree-pool.js";
import { removeDesktopBuildArtifacts } from "../worktree/worktree-desktop-artifacts.js";
import { cleanupConflictingWorktree } from "../executor/worktree-cleanup-conflicting.js";
import { handleBranchConflict } from "../executor/worktree-branch-conflict-handle.js";
import * as branchConflicts from "../execution/branch-conflicts.js";

vi.mock("../worktree/worktree-db-hydrate.js", () => ({ hydrateWorktreeDb: vi.fn().mockResolvedValue({ degraded: false, tasksCopied: 0, documentsCopied: 0, artifactsCopied: 0 }) }));
vi.mock("../worktree/worktree-desktop-artifacts.js", () => ({ removeDesktopBuildArtifacts: vi.fn().mockResolvedValue({ removed: [], skipped: [], failures: [] }) }));
vi.mock("../worktree/worktree-hooks.js", () => ({ installTaskWorktreeIdentityGuard: vi.fn().mockResolvedValue(undefined) }));

const roots: string[] = [];
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function fixture() {
  const rootDir = mkdtempSync(join(tmpdir(), "fusion legacy checkout ")); roots.push(rootDir);
  git(rootDir, "init", "-b", "main"); git(rootDir, "config", "user.name", "Fixture"); git(rootDir, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(rootDir, "tracked.txt"), "original\n"); git(rootDir, "add", "tracked.txt"); git(rootDir, "commit", "-m", "fixture");
  const worktree = join(rootDir, ".worktrees", "quiet-hare"); mkdirSync(join(rootDir, ".worktrees"));
  git(rootDir, "worktree", "add", "-b", "fusion/fn-501", worktree, "main");
  writeFileSync(join(worktree, "tracked.txt"), "retained change\n"); writeFileSync(join(worktree, "untracked.txt"), "retained draft\n");
  const task = { id: "FN-501", title: "fixture", description: "fixture", branch: "fusion/fn-501", worktree, column: "in-review" } as any;
  const store = { updateTask: vi.fn(async (_id, patch) => Object.assign(task, patch)), logEntry: vi.fn().mockResolvedValue(undefined), listTasks: vi.fn(async () => [task]) } as any;
  return { rootDir, worktree, task, store };
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function proveRetained(f: ReturnType<typeof fixture>) {
  expect(f.task.worktree).toBe(f.worktree);
  expect(git(f.worktree, "rev-parse", "--show-toplevel").replaceAll("\\", "/")).toBe(f.worktree.replaceAll("\\", "/"));
  expect(git(f.worktree, "branch", "--show-current")).toBe("fusion/fn-501");
  expect(readFileSync(join(f.worktree, "tracked.txt"), "utf8")).toBe("retained change\n");
  expect(readFileSync(join(f.worktree, "untracked.txt"), "utf8")).toBe("retained draft\n");
  expect(await scanIdleWorktrees(f.rootDir, f.store, {})).not.toContain(f.worktree);
}

describe("legacy random-name checkout acquisition", () => {
  it("reuses the assigned registered branch without creating a replacement", async () => {
    const f = fixture(); const createWorktree = vi.fn(async () => { throw Error("unexpected replacement"); });
    const result = await acquireTaskWorktree({ task: f.task, rootDir: f.rootDir, store: f.store, settings: {}, createWorktree });
    expect(result).toMatchObject({ source: "existing", worktreePath: f.worktree, isResume: true });
    expect(createWorktree).not.toHaveBeenCalled(); await proveRetained(f);
  });
  it("failed acquisition leaves assignment and all preserved work protected from orphan cleanup", async () => {
    const f = fixture(); vi.mocked(removeDesktopBuildArtifacts).mockRejectedValueOnce(Error("fixture preparation failure"));
    const createWorktree = vi.fn(async () => { throw Error("fixture create failure"); });
    await expect(acquireTaskWorktree({ task: f.task, rootDir: f.rootDir, store: f.store, settings: {}, createWorktree })).rejects.toThrow(/fixture/);
    await proveRetained(f);
  });
  it("conflict cleanup cannot dispose an unfinished task's assigned checkout between sessions", async () => {
    const f = fixture();
    const remove = vi.fn().mockResolvedValue(undefined);
    const result = await cleanupConflictingWorktree({ rootDir: f.rootDir,
      store: { ...f.store, getTask: async () => f.task, getSettings: async () => ({}), clearStaleExecutionStartBranchReferences: vi.fn() },
      reconcileSelfOwnedBeforeRemove: vi.fn().mockResolvedValue(undefined),
      findActiveWorktreeOwner: async () => null, removeOwnWorktreeWithReconcile: remove }, f.worktree, f.task.branch, f.task.id);
    expect(result).toBe(false); expect(remove).not.toHaveBeenCalled(); await proveRetained(f);
  });
  it("tip-already-merged recovery respects cleanup refusal without clearing the assignment or deleting the branch", async () => {
    const f = fixture(); const tipSha = git(f.rootDir, "rev-parse", f.task.branch);
    f.task.baseBranch = "main"; f.task.baseCommitSha = tipSha;
    vi.spyOn(branchConflicts, "inspectBranchConflict").mockResolvedValueOnce({ kind: "tip-already-merged", livePath: f.worktree, tipSha, integrationRef: "main" } as any);
    const cleanup = vi.fn().mockResolvedValue(false);
    const result = await handleBranchConflict({ rootDir: f.rootDir,
      store: { ...f.store, getSettings: async () => ({}), appendAgentLog: vi.fn() },
      getRunContextFor: () => undefined, findActiveWorktreeOwner: async () => null,
      cleanupConflictingWorktree: cleanup } as any, f.task,
      new branchConflicts.BranchConflictError({ branchName: f.task.branch, conflictingWorktreePath: f.worktree,
        existingTipSha: tipSha, strandedCommits: [], startPoint: "main", recommendedAction: "reclaim" }));
    expect(result).toBe("sticky"); expect(cleanup).toHaveBeenCalledWith(f.worktree, f.task.branch, f.task.id);
    expect(f.store.updateTask).not.toHaveBeenCalled(); expect(f.task.baseCommitSha).toBe(tipSha);
    expect(git(f.rootDir, "rev-parse", "refs/heads/fusion/fn-501")).toBe(tipSha);
    await proveRetained(f);
  });
});
