import { describe, expect, it, vi } from "vitest";
import { getTaskMergeBlocker, type Task, type WorkflowStepResult } from "@fusion/core";
import { SelfHealingManager } from "../self-healing.js";
import { recoverFailedPreMergeWorkflowStep } from "../executor/recover-failed-pre-merge-step.js";
import { routeRetryableRemediationGraphFailureToPreMergeFix } from "../executor/route-retryable-remediation.js";

function harness(result: Partial<WorkflowStepResult>, workflowId = "builtin:coding-ideas") {
  const row = {
    id: "FN-review-provider", title: "Review transport regression", description: "fixture",
    column: "in-review", status: null, paused: false, branch: "fusion/review-provider",
    worktree: "/isolated/review-provider", dependencies: [], modifiedFiles: ["src/fix.ts"],
    steps: [{ name: "Implementation", status: "done" }], currentStep: 0,
    postReviewFixCount: 0, log: [], createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
    workflowStepResults: [{ workflowStepId: "code-review", workflowStepName: "Code Review",
      phase: "pre-merge", status: "failed", startedAt: "2026-09-09T00:00:00Z",
      completedAt: "2026-09-09T00:01:00Z", output: "Provider unavailable; no review verdict", ...result }],
  } as Task;
  const store = {
    getSettings: vi.fn(async () => ({ autoMerge: true, globalPause: false, enginePaused: false, maxPostReviewFixes: 3 })),
    listTasks: vi.fn(async ({ column }: { column?: string } = {}) => !column || column === row.column ? [row] : []),
    getTask: vi.fn(async () => row),
    getTaskWorkflowSelection: vi.fn(async () => ({ workflowId, stepIds: [] })),
    getWorkflowDefinition: vi.fn(async () => undefined),
    listWorkflowDefinitions: vi.fn(async () => []),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(row, patch)),
    logEntry: vi.fn(async (_id: string, action: string, outcome?: string) => {
      row.log!.push({ action, outcome } as never);
    }),
  };
  const budget = vi.fn(async () => ({ unbounded: false, max: 3, attempts: 0, label: "3", key: "code-review" }));
  const sendBack = vi.fn(async () => { row.column = "in-progress"; });
  const append = vi.fn(async () => "appended" as const);
  const recover = vi.fn(async (task: Task) => recoverFailedPreMergeWorkflowStep({
    store: store as never, resolveFailedPreMergeWorkflowStepBudget: budget,
    sendTaskBackForFix: sendBack, appendReviewRemediationSteps: append,
  }, task));
  return { row, store, budget, sendBack, append, recover };
}

const failedReviews: Array<[string, Partial<WorkflowStepResult>]> = [
  ["built-in absent verdict", {}],
  ["renamed code review", { workflowStepId: "custom-check", workflowStepName: "Peer audit", reviewKind: "code" }],
  ["renamed plan review", { workflowStepId: "plan-check", workflowStepName: "Design audit", reviewKind: "plan" }],
  ["custom verdict-required review", { workflowStepId: "validation", workflowStepName: "Validation", verdictRequired: true }],
  ["non-revision verdict", { verdict: "APPROVE" }],
  ["malformed verdict", { verdict: "invalid" as never }],
];

describe("provider/protocol review failure does not request product repairs", () => {
  it.each(failedReviews)("graph recovery refuses %s before budget accounting", async (_label, result) => {
    const h = harness(result);
    const original = structuredClone(h.row);
    await expect(routeRetryableRemediationGraphFailureToPreMergeFix({
      store: h.store as never, getRunContextFor: () => undefined,
      isPreMergeRemediationGraphNode: vi.fn(async () => true),
      isLiveSharedBranchGroupMember: vi.fn(async () => false),
      resolveFailedPreMergeWorkflowStepBudget: h.budget,
      recoverFailedPreMergeWorkflowStep: h.recover,
      persistTokenUsage: vi.fn(async () => undefined),
    }, h.row as never, "code-review-remediation", "remediation-not-scheduled")).resolves.toBe(false);
    expect(h.row).toEqual(original);
    expect(h.budget).not.toHaveBeenCalled();
    expect(h.recover).not.toHaveBeenCalled();
    expect(h.store.updateTask).not.toHaveBeenCalled();
    expect(h.store.logEntry).not.toHaveBeenCalled();
  });
  it.each(failedReviews)("offline sweep keeps %s blocking without consuming fix budget", async (_label, result) => {
    const h = harness(result);
    const original = structuredClone(h.row);
    const manager = new SelfHealingManager(h.store as never, {
      rootDir: "/isolated", recoverFailedPreMergeStep: h.recover,
    });
    try {
      for (let sweep = 0; sweep < 2; sweep++) {
        await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(0);
      }
      expect(h.row).toEqual(original);
      expect(getTaskMergeBlocker(h.row)).toBe("task has failed pre-merge workflow steps");
      expect(h.store.updateTask).not.toHaveBeenCalled();
      expect(h.store.logEntry).not.toHaveBeenCalled();
      expect(h.recover).not.toHaveBeenCalled();
      expect(h.budget).not.toHaveBeenCalled();
      expect(h.sendBack).not.toHaveBeenCalled();
      expect(h.append).not.toHaveBeenCalled();
    } finally { manager.stop(); }
  });

  it.each(["builtin:coding-ideas", "builtin:coding-ideas-v2"])("direct recovery refuses no verdict under %s", async (workflowId) => {
    const h = harness({}, workflowId);
    const original = structuredClone(h.row);
    await expect(h.recover(h.row)).resolves.toBe(false);
    expect(h.row).toEqual(original);
    expect(h.budget).not.toHaveBeenCalled();
    expect(h.sendBack).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it.each([
    ["authored REVISE", { verdict: "REVISE" }],
    ["deterministic verification", { workflowStepId: "verification", workflowStepName: "Verification" }],
    ["legacy script verification", { workflowStepId: "custom-script", workflowStepName: "Run checks" }],
  ] as Array<[string, Partial<WorkflowStepResult>]>)("offline recovery still admits %s", async (_label, result) => {
    const h = harness(result, _label === "legacy script verification" ? "builtin:coding" : "builtin:coding-ideas");
    const manager = new SelfHealingManager(h.store as never, { rootDir: "/isolated", recoverFailedPreMergeStep: h.recover });
    try {
      await expect(manager.recoverReviewTasksWithFailedPreMergeSteps()).resolves.toBe(1);
      expect(h.recover).toHaveBeenCalledOnce();
      // Publication owns accounting; this sweep must not charge again. The producer here is a stub.
      expect(h.row.postReviewFixCount).toBe(0);
      expect(h.append.mock.calls.length + h.sendBack.mock.calls.length).toBe(1);
    } finally { manager.stop(); }
  });
});
