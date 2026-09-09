/**
 * FNXC:CodeOrganization 2026-08-03-10:55:
 * markStuckAborted peeled from TaskExecutor (U4).
 * Stuck-kill signal + bounded failure park if executor never unwinds.
 *
 * FNXC:WorkflowLifecycleColumns 2026-07-30-21:40 (fleet): force-requeue skips when task left WIP.
 * FNXC:Workspace 2026-06-21-22:30: F8 — observability for multi-worktree skip.
 * FNXC:StuckRequeue 2026-06-27-23:15: reconcile steps before reaping hung worktree.
 */
import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";
import { recoveryIsHeld } from "./recovery-pause-guard.js";

export type MarkStuckAbortedDeps = {
  store: TaskStore;
  activeStepExecutors: Map<string, { terminateAllSessions(): Promise<void> }>;
  stuckAborted: Map<string, boolean>;
  executing: Set<string>;
  loopRecoveryState: Map<string, unknown>;
  terminateAllChildren: (taskId: string) => Promise<void>;
  awaitAbortInFlightTaskWork: (taskId: string, reason: string) => Promise<void>;
  clearPausedAborted: (taskId: string) => void;
  reexecuteTaskInPlace: (taskId: string) => Promise<void>;
  getRunContextFor: (taskId: string) => { runId: string } | undefined;
};

export function markStuckAborted(
  deps: MarkStuckAbortedDeps,
  taskId: string,
): void {

  // Terminate step-session executor if active
  const stepExecutor = deps.activeStepExecutors.get(taskId);
  if (stepExecutor) {
    stepExecutor.terminateAllSessions().catch(err =>
      executorLog.warn(`Failed to terminate step sessions for stuck task ${taskId}: ${err}`)
    );
  }
  deps.stuckAborted.set(taskId, true);

  /*
  FNXC:StuckSessionRecovery 2026-08-28-07:48:
  If disposal cannot unwind the old executor, preserve its ownership and all progress.
  A late predecessor must never dispose a successor's session or checkout.
  */
  if (deps.executing.has(taskId)) {
    const ownerRunId = deps.getRunContextFor(taskId)?.runId;
    const stillOwned = () => Boolean(ownerRunId && deps.getRunContextFor(taskId)?.runId === ownerRunId && deps.executing.has(taskId));
    const UNWIND_GRACE_MS = 60_000;
    setTimeout(async () => {
      if (!stillOwned()) return;
      try {
        if (await recoveryIsHeld(deps.store, taskId) || !stillOwned()) return;
        await deps.terminateAllChildren(taskId);
        if (await recoveryIsHeld(deps.store, taskId) || !stillOwned()) return;
        await deps.awaitAbortInFlightTaskWork(taskId, "stuck-session unwind timeout; preserving predecessor ownership");
        if (await recoveryIsHeld(deps.store, taskId) || !stillOwned()) return;
        /* FNXC:RecoveryPause 2026-09-09-05:16:
         * Session disposal is not graph completion. Keep this run's ownership
         * and abort markers until its own finally settles; never start a successor
         * whose children could be killed by the predecessor's late cleanup.
         */
        await deps.store.updateTask(taskId, {
          status: "failed", paused: true, pausedReason: "stuck-cleanup-incomplete",
          error: "STUCK_CLEANUP_INCOMPLETE: predecessor execution has not settled; stop the owning instance before resuming",
        });
        await deps.store.logEntry(taskId, "Stuck-session cleanup remains incomplete — ownership and progress retained; no successor dispatched");
      } catch (error: unknown) {
        executorLog.error(`Failed to force-resume stuck task ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, UNWIND_GRACE_MS);
  }
  
}
