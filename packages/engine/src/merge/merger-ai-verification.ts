import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Settings, Task, TaskStore } from "@fusion/core";
import { runVerificationCommand } from "../execution/verification-utils.js";
import { assertMergeGenerationOwned } from "./merge-write-fence.js";
import { isMergeActiveStatus } from "./merge-active-status.js";
import { inferDefaultTestCommand } from "./merger-workspace-test-commands.js";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd, encoding: "utf8", timeout: 10_000, windowsHide: true })).stdout.trim();
}

function commandIdentity(settings: Settings): string {
  return JSON.stringify([settings.testCommand?.trim(), settings.buildCommand?.trim(),
    settings.verificationCommandTimeoutMs, settings.scopeVerificationToChangedFiles]);
}

function taskIdentity(task: Task): string {
  return JSON.stringify([task.branch, task.column, isMergeActiveStatus(task.status) ? null : task.status, task.enabledWorkflowSteps,
    task.workflowStepResults, task.aiMergeReviewReconciliation]);
}

/**
 * FNXC:AIMergeVerification 2026-09-06-02:38:
 * Production AI merges must run the operator's exact configured checks before landing,
 * not ask an agent to discover broad suites. Each command runs once per candidate with
 * the shared timeout/cancellation runner, without cache or automatic bootstrap/retry.
 * The returned fence binds proof to clean HEAD, source, settings and review episode;
 * callers must use it again at the actual ref-advance seam, including recovery lands.
 */
export async function verifyAiMergeCandidate(input: {
  store: TaskStore;
  taskId: string;
  mergeRoot: string;
  branch: string;
  tipSha: string;
  squashSha: string;
  signal?: AbortSignal;
  log: (message: string) => Promise<void>;
}, readGit: typeof git = git): Promise<() => Promise<void>> {
  const { store, taskId, mergeRoot, branch, tipSha, squashSha, signal, log } = input;
  const readAuthority = async () => {
    assertMergeGenerationOwned(signal, taskId);
    const [task, settings] = await Promise.all([store.getTask(taskId), store.getSettings()]);
    if (!task || !settings) throw new Error("AI merge verification authority unavailable");
    if (task.paused || task.userPaused || settings.globalPause || settings.enginePaused) {
      throw new Error("AI merge verification refused: automation or task is paused");
    }
    return { task, settings };
  };
  const initial = await readAuthority();
  const sourceSha = await readGit(mergeRoot, ["rev-parse", "--verify", branch]);
  const episode = taskIdentity(initial.task);
  const settingsIdentity = commandIdentity(initial.settings);
  const state = initial.task.aiMergeReviewReconciliation;
  if (state && (state.candidateSha !== squashSha || state.sourceSha !== sourceSha || state.integrationTipSha !== tipSha)) {
    throw new Error("AI merge verification refused: approved candidate identity changed");
  }
  const assertAuthority = async (): Promise<void> => {
    const current = await readAuthority();
    if (commandIdentity(current.settings) !== settingsIdentity
      || taskIdentity(current.task) !== episode) {
      throw new Error("AI merge verification refused: settings or review episode changed");
    }
  };
  const assertVerifiedCandidate = async (): Promise<void> => {
    await assertAuthority();
    const [head, source, dirty] = await Promise.all([
      readGit(mergeRoot, ["rev-parse", "--verify", "HEAD"]),
      readGit(mergeRoot, ["rev-parse", "--verify", branch]),
      readGit(mergeRoot, ["status", "--porcelain", "--untracked-files=all"]),
    ]);
    if (head !== squashSha || source !== sourceSha || dirty) {
      throw new Error("AI merge verification refused: candidate HEAD, source or worktree changed");
    }
    // FNXC:AIMergeVerification 2026-09-06-02:38: Git probes await subprocesses. Re-read durable authority after them so a pause/configuration/review change during the probe cannot grant stale landing permission.
    await assertAuthority();
    assertMergeGenerationOwned(signal, taskId);
  };
  await assertVerifiedCandidate();
  const { settings } = initial;
  // Explicit commands win unchanged; inference is only for an absent test command.
  const testCommand = settings.testCommand?.trim() || inferDefaultTestCommand(
    mergeRoot, undefined, settings.buildCommand, tipSha, squashSha,
    settings.scopeVerificationToChangedFiles !== false,
  )?.command;
  const commands = [
    { type: "test" as const, command: testCommand },
    { type: "build" as const, command: settings.buildCommand?.trim() },
  ].filter((entry): entry is { type: "test" | "build"; command: string } => Boolean(entry.command));
  if (!commands.length) {
    await log(`AI merge verification: not-run (no configured or inferred commands), candidate=${squashSha}`);
  }
  for (const { type, command } of commands) {
    await assertVerifiedCandidate();
    const result = await runVerificationCommand(store, mergeRoot, taskId, command, type, signal,
      undefined, "merger", undefined, settings.verificationCommandTimeoutMs);
    await log(`AI merge verification: ${type} candidate=${squashSha} exit=${result.exitCode} timedOut=${result.timedOut === true} aborted=${result.aborted === true}`);
    if (result.exitCode !== 0 || !result.success || result.timedOut || result.aborted || result.executionError || result.cached) {
      throw new Error(`AI merge verification failed: ${type}; candidate not landed`);
    }
    await assertVerifiedCandidate();
  }
  return assertVerifiedCandidate;
}
