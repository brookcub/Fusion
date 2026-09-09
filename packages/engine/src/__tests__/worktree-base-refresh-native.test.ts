import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { refreshReusedWorktreeBase } from "../worktree-base-refresh.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fusion native base "));
  roots.push(root);
  git(root, "init", "-b", "lab-integration");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "Fixture");
  writeFileSync(join(root, "base.txt"), "base\n");
  git(root, "add", "base.txt"); git(root, "commit", "-m", "base");
  const original = git(root, "rev-parse", "HEAD");
  const worktree = join(root, "task space");
  git(root, "worktree", "add", "-b", "fusion/native-fixture", worktree, original);
  writeFileSync(join(root, "landed.txt"), "landed\n");
  git(root, "add", "landed.txt"); git(root, "commit", "-m", "landed");
  const tip = git(root, "rev-parse", "HEAD");
  return { root, worktree, original, tip };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("native-shell worktree base refresh in spaced paths", () => {
  it("resolves and advances a clean lab-integration base", async () => {
    const f = fixture(); const updateTask = vi.fn();
    const result = await refreshReusedWorktreeBase({ task: { id: "fixture", baseCommitSha: f.original } as any,
      rootDir: f.root, worktreePath: f.worktree, store: { updateTask } as any, settings: { integrationBranch: "lab-integration" } });
    expect(result).toMatchObject({ kind: "reset-to-base", executionSafe: true, baseSha: f.tip });
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.tip);
    expect(updateTask).toHaveBeenCalledWith("fixture", { baseCommitSha: f.tip });
  });
  it("does not discard dirty task bytes", async () => {
    const f = fixture(); const updateTask = vi.fn();
    writeFileSync(join(f.worktree, "base.txt"), "unfinished work\n");
    const result = await refreshReusedWorktreeBase({ task: { id: "fixture", baseCommitSha: f.original } as any,
      rootDir: f.root, worktreePath: f.worktree, store: { updateTask } as any, settings: { integrationBranch: "lab-integration" } });
    expect(result).toMatchObject({ kind: "dirty-worktree", executionSafe: true, skipped: true });
    expect(readFileSync(join(f.worktree, "base.txt"), "utf8")).toBe("unfinished work\n");
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.original);
    expect(updateTask).not.toHaveBeenCalled();
  });
  it("compensates to the original commit if durable baseline persistence fails", async () => {
    const f = fixture();
    const result = await refreshReusedWorktreeBase({ task: { id: "fixture", baseCommitSha: f.original } as any,
      rootDir: f.root, worktreePath: f.worktree, store: { updateTask: vi.fn().mockRejectedValue(new Error("fixture failure")) } as any,
      settings: { integrationBranch: "lab-integration" } });
    expect(result).toMatchObject({ kind: "base-persistence-failed-compensated", executionSafe: true });
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(f.original);
    expect(git(f.worktree, "status", "--porcelain")).toBe("");
  });
  it("rebases an own commit without losing its content", async () => {
    const f = fixture(); const updateTask = vi.fn();
    writeFileSync(join(f.worktree, "own.txt"), "owned work\n");
    git(f.worktree, "add", "own.txt"); git(f.worktree, "commit", "-m", "own");
    const result = await refreshReusedWorktreeBase({ task: { id: "fixture", baseCommitSha: f.original } as any,
      rootDir: f.root, worktreePath: f.worktree, store: { updateTask } as any, settings: { integrationBranch: "lab-integration" } });
    expect(result).toMatchObject({ kind: "rebased", executionSafe: true, baseSha: f.tip });
    expect(git(f.worktree, "merge-base", "--is-ancestor", f.tip, "HEAD")).toBe("");
    expect(readFileSync(join(f.worktree, "own.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("owned work\n");
    expect(updateTask).toHaveBeenCalledWith("fixture", { baseCommitSha: f.tip });
  });
  it("aborts a conflicting rebase and restores the original own commit", async () => {
    const f = fixture(); const updateTask = vi.fn();
    writeFileSync(join(f.worktree, "base.txt"), "own conflicting work\n");
    git(f.worktree, "add", "base.txt"); git(f.worktree, "commit", "-m", "own conflict");
    const ownHead = git(f.worktree, "rev-parse", "HEAD");
    writeFileSync(join(f.root, "base.txt"), "main conflicting work\n");
    git(f.root, "add", "base.txt"); git(f.root, "commit", "-m", "main conflict");
    const result = await refreshReusedWorktreeBase({ task: { id: "fixture", baseCommitSha: f.original } as any,
      rootDir: f.root, worktreePath: f.worktree, store: { updateTask } as any, settings: { integrationBranch: "lab-integration" } });
    expect(result).toMatchObject({ kind: "stale-base-conflict", executionSafe: true, skipped: true });
    expect(git(f.worktree, "rev-parse", "HEAD")).toBe(ownHead);
    expect(git(f.worktree, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(f.worktree, "base.txt"), "utf8").replace(/\r\n/g, "\n")).toBe("own conflicting work\n");
    expect(updateTask).not.toHaveBeenCalled();
  });
});
