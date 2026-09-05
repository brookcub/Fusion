import { afterEach, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectOwnTaskCommitsForRange, filterFilesToOwnTaskCommits } from "../execution/branch-attribution.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// FNXC:WindowsGit 2026-09-05-08:50: exercise native git, not a string-return mock.
it("attributes real commits from a spaced checkout without shell-quoted refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "fusion native attribution ")); roots.push(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true });
  git("init", "--quiet");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "baseline");
  const base = git("rev-parse", "HEAD").trim();
  writeFileSync(join(root, "smoke.txt"), "fixture\n"); git("add", "smoke.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "fix(KB-001): native attribution");
  const result = await filterFilesToOwnTaskCommits({ worktreePath: root, baseRef: base, taskId: "KB-001" });
  expect(result.files).toEqual(["smoke.txt"]);
  expect(result.ownCommitCount).toBe(1);
  expect(result.foreignCommits).toEqual([]);
  expect(await collectOwnTaskCommitsForRange({ worktreePath: root, rangeRef: `${base}..HEAD`, taskId: "KB-001" })).toMatchObject({ ownCommitCount: 1 });
});
