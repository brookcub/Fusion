import { createHash } from "node:crypto";
import { ACTIVE_WORKFLOW_WORK_ITEM_STATES, getBuiltinWorkflow, parseWorkflowIr, resolveWorkflowIrForTaskWithProvenance, type Task, type TaskStore, type WorkflowIr } from "@fusion/core";

const entryId = "post-merge-verification";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export class PostMergeRecoveryRefusal extends Error {}
const refuse = (reason: string): never => { throw new PostMergeRecoveryRefusal(reason); };

export interface PostMergeRecoveryPlan {
  taskId: string;
  commitSha: string;
  entryNodeId: string;
  taskFingerprint: string;
  irFingerprint: string;
}

// FNXC:PostMergeRecovery 2026-09-07-02:00: Recovery must preserve landed work and
// earlier reviews. Only the built-in read-only verification tail is supported;
// arbitrary custom graphs, extra groups, inline fixes and backward edges refuse.
function taskFingerprint(task: Task): string {
  return hash({ id: task.id, column: task.column, deletedAt: task.deletedAt ?? null,
    archivedAt: task.archivedAt ?? null, steps: task.steps, enabled: task.enabledWorkflowSteps,
    mergeDetails: task.mergeDetails, branch: task.branch, nodeId: task.nodeId,
    preMergeResults: task.workflowStepResults?.filter((r) => r.phase !== "post-merge") });
}

export function recoveryTaskIsCurrent(task: Task, plan: PostMergeRecoveryPlan): boolean {
  return task.id === plan.taskId && task.column === "done" && !task.deletedAt && !task.archivedAt
    && !task.paused && !task.userPaused && !task.error && !task.status
    && task.mergeDetails?.mergeConfirmed === true && task.mergeDetails.commitSha === plan.commitSha
    && taskFingerprint(task) === plan.taskFingerprint;
}

export function planPostMergeRecovery(task: Task, ir: WorkflowIr, expectedCommitSha: string): PostMergeRecoveryPlan | null {
  if (!/^[0-9a-f]{40}$/.test(expectedCommitSha)) refuse("An exact landed commit is required");
  if (task.column !== "done" || task.deletedAt || task.archivedAt || task.error || task.status)
    refuse("Recovery requires a clean landed task in the complete column");
  if (task.paused || task.userPaused) refuse("Task is paused");
  if (task.mergeDetails?.mergeConfirmed !== true || task.mergeDetails.commitSha !== expectedCommitSha)
    refuse("Landed commit proof changed or is unavailable");
  if (!task.steps?.length || task.steps.some((step) => step.status !== "done")) refuse("Implementation is incomplete");
  if (!task.enabledWorkflowSteps?.includes(entryId)) refuse("Post-merge verification is not enabled");
  const canonical = getBuiltinWorkflow("builtin:coding")?.ir;
  if (!canonical) refuse("Built-in workflow is unavailable");
  if (hash(ir) !== hash(canonical)) refuse("Recovery supports only the unchanged built-in coding workflow");
  const postMerge = task.workflowStepResults?.filter((r) => r.workflowStepId === entryId) ?? [];
  if (postMerge.some((r) => r.phase !== "post-merge")) refuse("Ambiguous verification evidence");
  if (postMerge.length > 1) refuse("Ambiguous verification attempts");
  if (postMerge[0]?.status === "passed") return null;
  for (const id of (task.enabledWorkflowSteps ?? []).filter((id) => id !== entryId)) {
    const result = task.workflowStepResults?.find((r) => r.workflowStepId === id);
    if (!result || !["passed", "skipped"].includes(result.status)) refuse("Earlier workflow gates are incomplete");
  }
  return { taskId: task.id, commitSha: expectedCommitSha, entryNodeId: entryId,
    taskFingerprint: taskFingerprint(task), irFingerprint: hash(parseWorkflowIr(ir)) };
}

export function assertRecoveryIr(ir: WorkflowIr | undefined, plan: PostMergeRecoveryPlan): void {
  if (!ir || hash(parseWorkflowIr(ir)) !== plan.irFingerprint) refuse("Recovery execution workflow changed");
}

export function requireRecoveryPublication(outcome: { persisted: boolean; scopeCurrent: boolean }): void {
  if (!outcome.persisted || !outcome.scopeCurrent) refuse("Recovery result publication refused");
}

async function readRecoveryIr(store: TaskStore, taskId: string): Promise<WorkflowIr> {
  const resolved = await resolveWorkflowIrForTaskWithProvenance(store, taskId);
  if (resolved.source !== "selection" || resolved.workflowId !== "builtin:coding")
    refuse("Recovery workflow authority is unavailable");
  return resolved.ir;
}

export async function readPostMergeRecoveryPlan(store: TaskStore, taskId: string, expectedCommitSha: string): Promise<PostMergeRecoveryPlan | null> {
  const [task, settings, selection, workItems] = await Promise.all([
    store.getTask(taskId), store.getSettings(), store.getTaskWorkflowSelectionAsync(taskId),
    store.listWorkflowWorkItemsForTask(taskId),
  ]);
  if (!task) refuse("Task is unavailable");
  if (settings.enginePaused || settings.globalPause) refuse("Project automation is paused");
  if (selection?.workflowId !== "builtin:coding") refuse("Unsupported recovery workflow");
  if (workItems.some((item) => ACTIVE_WORKFLOW_WORK_ITEM_STATES.includes(item.state))) refuse("Task has active workflow ownership");
  return planPostMergeRecovery(task, await readRecoveryIr(store, taskId), expectedCommitSha);
}

export async function assertRecoveryCurrent(store: TaskStore, plan: PostMergeRecoveryPlan): Promise<void> {
  const [task, settings, ir, selection] = await Promise.all([
    store.getTask(plan.taskId), store.getSettings(), readRecoveryIr(store, plan.taskId),
    store.getTaskWorkflowSelectionAsync(plan.taskId),
  ]);
  if (!recoveryTaskIsCurrent(task, plan) || settings.enginePaused || settings.globalPause
    || selection?.workflowId !== "builtin:coding" || hash(parseWorkflowIr(ir)) !== plan.irFingerprint)
    refuse("Post-merge recovery identity or pause authority changed");
}
