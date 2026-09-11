// Real-git wallclock under parallel CI load; do not lower per-test timeouts
// without re-measuring under pnpm test:full. (FN-4839)
import { afterEach, describe, expect, it } from "vitest";
import { appendFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

describe("inspectBranchConflict ghost references", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function setupRepo() {
    const repoDir = await mkdtemp(path.join(tmpdir(), "fn-4508-branch-conflict-"));
    dirs.push(repoDir);
    await git(repoDir, "init", "-b", "main");
    await git(repoDir, "config", "user.email", "test@example.com");
    await git(repoDir, "config", "user.name", "Test User");
    await writeFile(path.join(repoDir, "note.txt"), "base\n", "utf-8");
    await git(repoDir, "add", "note.txt");
    await git(repoDir, "commit", "-m", "chore: base");
    return repoDir;
  }

  it("returns stale-resolved when live branch mapping points to missing ghost path", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "checkout", "-b", "fusion/fn-9999");
    await git(repoDir, "checkout", "main");
    const livePath = path.join(repoDir, ".worktrees/ghost-cat");
    await git(repoDir, "worktree", "add", livePath, "fusion/fn-9999");
    await rm(livePath, { recursive: true, force: true });
    const conflictingPath = path.join(repoDir, "conflict-path");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "main",
    });

    expect(result.kind).toBe("stale-resolved");
  }, 20_000);

  it("returns tip-already-merged when branch tip is reachable from main despite stale startPoint", async () => {
    const repoDir = await setupRepo();
    const staleStartPoint = await git(repoDir, "rev-parse", "HEAD");
    for (let i = 0; i < 5; i += 1) {
      await appendFile(path.join(repoDir, "note.txt"), `m${i}\n`, "utf-8");
      await git(repoDir, "add", "note.txt");
      await git(repoDir, "commit", "-m", `chore: main-${i}`);
    }
    await git(repoDir, "branch", "fusion/fn-9999");
    const livePath = path.join(repoDir, "wt-live");
    await git(repoDir, "worktree", "add", livePath, "fusion/fn-9999");
    const conflictingPath = path.join(repoDir, "conflict-live");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: staleStartPoint,
    });

    expect(result.kind).toBe("tip-already-merged");
    if (result.kind === "tip-already-merged") {
      expect(result.integrationRef).toBe("main");
      expect(result.tipSha).toBe(await git(repoDir, "rev-parse", "fusion/fn-9999"));
    }
  }, 20_000);

  it("returns tip-already-merged when startPoint is HEAD and tip is ancestor", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "branch", "fusion/fn-9999");
    const livePath = path.join(repoDir, "wt-head");
    await git(repoDir, "worktree", "add", livePath, "fusion/fn-9999");
    const conflictingPath = path.join(repoDir, "conflict-head");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "HEAD",
    });

    expect(result.kind).toBe("tip-already-merged");
  }, 20_000);

  it("keeps genuine live-foreign conflicts unchanged", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "checkout", "-b", "topic/other");
    await appendFile(path.join(repoDir, "note.txt"), "foreign\n", "utf-8");
    await git(repoDir, "add", "note.txt");
    await git(repoDir, "commit", "-m", "chore: foreign work");
    await git(repoDir, "checkout", "main");
    const livePath = path.join(repoDir, "wt-foreign");
    await git(repoDir, "worktree", "add", livePath, "topic/other");
    const conflictingPath = path.join(repoDir, "conflict-foreign");
    await mkdir(conflictingPath, { recursive: true });

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "topic/other",
      conflictingWorktreePath: conflictingPath,
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "main",
    });

    expect(result.kind).toBe("live-foreign");
    if (result.kind === "live-foreign") {
      expect(result.error.name).toBe("BranchConflictError");
    }
  }, 20_000);

  it("keeps stale conflictingWorktreePath short-circuit behavior", async () => {
    const repoDir = await setupRepo();
    await git(repoDir, "branch", "fusion/fn-9999");

    const result = await inspectBranchConflict({
      repoDir,
      branchName: "fusion/fn-9999",
      conflictingWorktreePath: path.join(repoDir, "missing-conflict-path"),
      requestingTaskId: "FN-9999",
      ownerTaskId: "FN-9999",
      startPoint: "main",
    });

    expect(result.kind).toBe("stale");
  }, 20_000);
});
