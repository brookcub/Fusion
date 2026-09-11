import { afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBranchConflict } from "../execution/branch-conflicts.js";

const execute = promisify(execFile);
const fixtures: string[] = [];
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", args, { cwd, timeout: 5000 })).stdout.trim();
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion native branch "));
  fixtures.push(root);
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Fixture");
  await git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "base.txt"), "base\n");
  await git(root, "add", "base.txt");
  await git(root, "commit", "-m", "base");
  const worktree = join(root, "task checkout");
  await git(root, "worktree", "add", "-b", "fusion/fusi-999", worktree);
  return { root, worktree };
}
afterEach(async () => {
  for (const path of fixtures.splice(0)) await rm(path, { recursive: true, force: true });
});
describe("native branch inspection", () => {
  it("recognizes a live task branch in paths with spaces without a shell", async () => {
    const { root, worktree } = await fixture();
    await writeFile(join(worktree, "task.txt"), "unmerged\n");
    await git(worktree, "add", "task.txt");
    await git(worktree, "commit", "-m", "fix(FUSI-999): fixture", "-m", "Fusion-Task-Id: FUSI-999");
    const tip = await git(worktree, "rev-parse", "HEAD");
    const result = await inspectBranchConflict({ repoDir: root, branchName: "fusion/fusi-999",
      conflictingWorktreePath: worktree, requestingTaskId: "FUSI-999", startPoint: "main", integrationRef: "main" });
    expect(result.kind).toBe("reclaimable");
    expect(result).toMatchObject({ tipSha: tip, taskAttributedCommitCount: 1 });
    expect(await git(worktree, "rev-parse", "HEAD")).toBe(tip);
  });
  it("does not classify an invalid ref probe as a missing branch", async () => {
    const { root, worktree } = await fixture();
    await expect(inspectBranchConflict({ repoDir: root, branchName: "bad..ref",
      conflictingWorktreePath: worktree, requestingTaskId: "FUSI-999", integrationRef: "main" })).rejects.toThrow();
  });
  it("distinguishes a proven missing ref from a corrupt repository ref", async () => {
    const { root, worktree } = await fixture();
    const input = { repoDir: root, branchName: "fusion/missing", conflictingWorktreePath: worktree,
      requestingTaskId: "FUSI-999", integrationRef: "main" };
    expect(await inspectBranchConflict(input)).toEqual({ kind: "stale-resolved" });
    await writeFile(join(root, ".git", "refs", "heads", "fusion", "missing"), "invalid object id\n");
    await expect(inspectBranchConflict(input)).rejects.toThrow();
    expect(await git(worktree, "rev-parse", "HEAD")).toMatch(/^[0-9a-f]{40}$/);
  });
});
