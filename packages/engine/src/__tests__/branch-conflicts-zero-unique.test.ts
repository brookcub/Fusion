// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inspectBranchConflict } from "../execution/branch-conflicts.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf-8" });
  return stdout.trim();
}

describe("inspectBranchConflict zero-unique behavior", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4500-branch-conflict-"));
    dirs.push(repoDir);
    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@example.com");
    await git(repoDir, "config", "user.name", "Test User");
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await git(repoDir, "add", "note.txt");
    await git(repoDir, "commit", "-m", "chore: base");
    return repoDir;
  }

  it("returns tip-already-merged when branch tip is ancestor of main", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "checkout", "-b", "fusion/fn-9001");
    await git(repoDir, "checkout", "main");
    const livePath = path.join(repoDir, "wt-live-9001");
    await git(repoDir, "worktree", "add", livePath, "fusion/fn-9001");
    const stalePath = path.join(repoDir, "wt-stale-9001");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("tip-already-merged");
  }, 20_000);

  it("classifies branch patch already existing upstream as merged/subsumed", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "checkout", "-b", "fusion/fn-9001");
    await appendFile(path.join(repoDir, "note.txt"), "change\n", "utf-8");
    await git(repoDir, "add", "note.txt");
    await git(repoDir, "commit", "-m", "feat(FN-9001): change", "-m", "Fusion-Task-Id: FN-9001");
    const branchCommit = await git(repoDir, "rev-parse", "HEAD");
    await git(repoDir, "checkout", "main");
    await git(repoDir, "cherry-pick", branchCommit);

    const livePath = path.join(repoDir, "wt-live-9001-upstream");
    await git(repoDir, "worktree", "add", livePath, "fusion/fn-9001");
    const stalePath = path.join(repoDir, "wt-stale-9001-upstream");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(["tip-already-merged", "fully-subsumed"]).toContain(result.kind);
  }, 20_000);

  it("returns reclaimable when branch still has unique commit", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "checkout", "-b", "fusion/fn-9001");
    await appendFile(path.join(repoDir, "note.txt"), "unique\n", "utf-8");
    await git(repoDir, "add", "note.txt");
    await git(repoDir, "commit", "-m", "feat(FN-9001): unique", "-m", "Fusion-Task-Id: FN-9001");
    await git(repoDir, "checkout", "main");

    const livePath = path.join(repoDir, "wt-live-9001-unique");
    await git(repoDir, "worktree", "add", livePath, "fusion/fn-9001");
    const stalePath = path.join(repoDir, "wt-stale-9001-unique");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "fusion/fn-9001", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("reclaimable");
  }, 20_000);

  it("keeps zero-attributed foreign branch as live-foreign", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "checkout", "-b", "topic/other");
    await appendFile(path.join(repoDir, "note.txt"), "other\n", "utf-8");
    await git(repoDir, "add", "note.txt");
    await git(repoDir, "commit", "-m", "chore: other work");
    await git(repoDir, "checkout", "main");

    const livePath = path.join(repoDir, "wt-live-other");
    await git(repoDir, "worktree", "add", livePath, "topic/other");
    const stalePath = path.join(repoDir, "wt-stale-other");
    await mkdir(stalePath, { recursive: true });

    const result = await inspectBranchConflict({ repoDir, branchName: "topic/other", conflictingWorktreePath: stalePath, requestingTaskId: "FN-9001", ownerTaskId: "FN-9001", startPoint: "main" });
    expect(result.kind).toBe("live-foreign");
  }, 20_000);
});
