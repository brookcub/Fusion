import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isWorkspaceTask, resolveTaskMergeTarget, type Settings, type Task, type TaskStore } from "@fusion/core";
import { resolveIntegrationBranch } from "../merge/integration-branch.js";
import { resolveBranchGroupMergeRouting } from "../merge/group-merge-coordinator.js";

const execFileAsync = promisify(execFile);
type Store = Pick<TaskStore, "getSettings" | "getBranchGroup" | "updateTaskAtomic">;
const oid = /^[0-9a-f]{40}$/;

/*
 * FNXC:ResumedReviewBase 2026-09-05-11:25:
 * A resumed task can incorporate a newer integration baseline while retaining
 * its original fork SHA. That turns a small review into the whole upstream
 * upgrade. Advance only a proven unique shared ancestor, never HEAD fallback,
 * and never interpret the smaller diff as task completion. Missing/ambiguous
 * history preserves the old proof; the existing review gate still fails closed.
 */
export async function findAdvancedReviewBase(worktree: string, stored: string, target: string, taskId: string) {
  const git = async (...args: string[]) => (await execFileAsync("git", args, {
    cwd: worktree, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
  })).stdout.trim();
  if (!oid.test(stored)) return undefined;
  try {
    const head = await git("rev-parse", "--verify", "HEAD^{commit}");
    const destination = await git("rev-parse", "--verify", "--end-of-options", `${target}^{commit}`);
    const bases = (await git("merge-base", "--all", head, destination)).split(/\r?\n/);
    const candidate = bases[0];
    if (bases.length !== 1 || !candidate || !oid.test(candidate)) return undefined;
    if (candidate === stored || candidate === head) return undefined;
    await git("merge-base", "--is-ancestor", stored, candidate);
    await git("merge-base", "--is-ancestor", candidate, head);
    await git("merge-base", "--is-ancestor", candidate, destination);
    // Conservatively preserve evidence of previously landed task commits.
    // Merge commit prose can mention tickets without owning their changes.
    if (await git("log", "-1", "--no-merges", "--format=%H", "--fixed-strings", "--regexp-ignore-case", `--grep=${taskId}`, `${stored}..${candidate}`)) return undefined;
    return { candidate, head, destination };
  } catch { return undefined; }
}

export async function reconcileResumeReviewBase(store: Store, rootDir: string, task: Task, settings: Settings): Promise<Task> {
  if (!task.worktree || !task.branch || !task.baseCommitSha || !oid.test(task.baseCommitSha)
      || isWorkspaceTask(task) || task.workspaceWorktrees !== undefined) return task;
  const git = async (...args: string[]) => (await execFileAsync("git", args, {
    cwd: task.worktree!, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true,
  })).stdout.trim();
  try {
    const projectDefaultBranch = await resolveIntegrationBranch(rootDir, settings);
    // No rootDir: resolving group policy must not create a branch.
    const group = await resolveBranchGroupMergeRouting({ task, store, projectDefaultBranch });
    const target = group?.mergeTarget ?? resolveTaskMergeTarget(task, { projectDefaultBranch });
    if (target.rejected || (await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== task.branch) return task;
    const proof = await findAdvancedReviewBase(task.worktree, task.baseCommitSha, target.branch, task.id);
    if (!proof) return task;
    return await store.updateTaskAtomic(task.id, async current => {
      const latest = await store.getSettings();
      if (current.paused || current.userPaused || current.deletedAt || latest.globalPause || latest.enginePaused
          || current.worktree !== task.worktree || current.branch !== task.branch || current.baseCommitSha !== task.baseCommitSha
          || JSON.stringify(current.branchContext) !== JSON.stringify(task.branchContext) || current.baseBranch !== task.baseBranch) return null;
      const currentDefault = await resolveIntegrationBranch(rootDir, latest);
      const currentGroup = await resolveBranchGroupMergeRouting({ task: current, store, projectDefaultBranch: currentDefault });
      const currentTarget = currentGroup?.mergeTarget ?? resolveTaskMergeTarget(current, { projectDefaultBranch: currentDefault });
      if (currentTarget.rejected || currentTarget.branch !== target.branch) return null;
      if ((await git("rev-parse", "--verify", "HEAD^{commit}")) !== proof.head
          || (await git("rev-parse", "--verify", "--end-of-options", `${target.branch}^{commit}`)) !== proof.destination) return null;
      if ((await git("symbolic-ref", "--quiet", "--short", "HEAD")) !== task.branch) return null;
      // FNXC:ResumedReviewBase 2026-09-05-11:50: project pause can arrive during Git probes.
      const finalSettings = await store.getSettings();
      if (finalSettings.globalPause || finalSettings.enginePaused
          || finalSettings.integrationBranch !== latest.integrationBranch) return null;
      return { baseCommitSha: proof.candidate };
    });
  } catch { return task; }
}
