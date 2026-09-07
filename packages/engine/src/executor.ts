// port-4040-allowlist: never kill port 4040. FNXC:CodeOrganization 2026-08-04-09:45: thin TaskExecutor shell (U4).
export * from "./executor/executor-reexports.js";
import { type TaskStore, type Task, type MergeResult, type TaskMoveLanes, dropPreHeldExecutorSlot, wireTaskExecutorLifecycle, type TaskExecutorOptions, TaskExecutorGraphFacades } from "./executor/task-executor-imports.js";
import { readPostMergeRecoveryPlan } from "./executor/post-merge-recovery.js";
export class TaskExecutor extends TaskExecutorGraphFacades {
  private readonly postMergeRecoveries = new Set<string>();
  // FNXC:PostMergeRecovery 2026-09-07-02:00: Explicit operator recovery owns one
  // asynchronous graph run; duplicate requests cannot restart implementation.
  async retryPostMerge(taskId: string, expectedCommitSha: string): Promise<{ outcome: "started" | "already-running" | "already-complete" }> {
    if (this.postMergeRecoveries.has(taskId)) return { outcome: "already-running" };
    this.postMergeRecoveries.add(taskId);
    let dispatched = false;
    try {
      if (this.graphRouting.has(taskId) || this.isTaskLiveForOverseerRetry(taskId)) throw new Error("Task execution is active");
      const plan = await readPostMergeRecoveryPlan(this.store, taskId, expectedCommitSha);
      if (!plan) return { outcome: "already-complete" };
      const task = await this.store.getTask(taskId);
      if (this.graphRouting.has(taskId) || this.isTaskLiveForOverseerRetry(taskId)) throw new Error("Task execution became active");
      const execution = this.executeWorkflowGraph(task, { postMergeRecovery: plan });
      dispatched = true;
      void execution.catch(() => this.store.logEntry(taskId, "Post-merge recovery stopped without verified completion").catch(() => undefined))
        .finally(() => this.postMergeRecoveries.delete(taskId));
      return { outcome: "started" };
    } finally {
      if (!dispatched) this.postMergeRecoveries.delete(taskId);
    }
  }
  private isBackwardMoveOutOfPlanning(_taskId: string, from: string, to: string, moveLanes: TaskMoveLanes | undefined): boolean { const lanes = moveLanes ?? { hold: "todo", intake: "triage", wip: "in-progress", review: "in-review", complete: "done" }; return (from === lanes.hold || from === lanes.intake) && ![lanes.wip, lanes.review, lanes.complete].filter((c): c is string => typeof c === "string").includes(to); }
  setOnExecutorLogFlushed(cb: TaskExecutorOptions["onExecutorLogFlushed"]): void { this.options = { ...this.options, onExecutorLogFlushed: cb }; }
  constructor(store: TaskStore, rootDir: string, options: TaskExecutorOptions = {}) { super(); this.store = store; this.rootDir = rootDir; this.options = options; wireTaskExecutorLifecycle(this); }
  setMergeRequester(requestMerge: (taskId: string, options?: { signal?: AbortSignal }) => Promise<MergeResult>): void { this.mergeRequester = requestMerge; }
  async execute(task: Task): Promise<void> { try { await this.executeCore(task); } finally { if (dropPreHeldExecutorSlot(task.id)) this.options.semaphore?.release(); } }
}
