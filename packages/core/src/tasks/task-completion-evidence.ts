import type { Settings, Task, WorkflowStepResult } from "../types.js";
import {
  classifyMergeVerificationEvidence,
  type MergeVerificationEvidence,
  type VerificationEvidenceReason,
} from "../merge/verification-evidence.js";

export type TaskCompletionVerificationStatus =
  | "verified"
  | "failed"
  | "pending"
  | "stale"
  | "unavailable"
  | "not-applicable";

export type TaskCompletionEvidence = {
  landed: boolean;
  verifiedComplete: boolean;
  verificationStatus: TaskCompletionVerificationStatus;
  requiredReasons: VerificationEvidenceReason[];
  advisoryFailureStepIds: string[];
  receiptEvidence: MergeVerificationEvidence;
};

export type TaskCompletionEvidenceContext = {
  /** Required post-merge step IDs resolved from the current workflow IR. */
  requiredPostMergeStepIds?: readonly string[];
  /** Required post-merge work currently owned by a graph session. */
  activeRequiredPostMergeStepIds?: readonly string[];
};

const evidencePriority: Record<TaskCompletionVerificationStatus, number> = {
  failed: 5,
  pending: 4,
  stale: 3,
  unavailable: 2,
  verified: 1,
  "not-applicable": 0,
};

/**
 * FNXC:CompletionEvidence 2026-09-09-04:24:
 * Completion is a read-only view of merge proof, current receipt identity, and resolved required
 * post-merge work. A landed commit remains landed when validation fails; only the verified-complete
 * claim changes. Callers must pass workflow policy rather than infer a gate from a display label.
 */
export function deriveTaskCompletionEvidence(
  task: Pick<Task, "mergeDetails" | "workflowStepResults"> | null | undefined,
  settings: Pick<Settings, "testCommand" | "buildCommand" | "verificationCommandTimeoutMs" | "scopeVerificationToChangedFiles"> | null | undefined,
  context: TaskCompletionEvidenceContext = {},
): TaskCompletionEvidence {
  const receiptEvidence = classifyMergeVerificationEvidence(task, settings);
  if (!receiptEvidence.mergeConfirmed) {
    return { landed: false, verifiedComplete: false, verificationStatus: "unavailable", requiredReasons: ["merge-unconfirmed"], advisoryFailureStepIds: [], receiptEvidence };
  }

  const requiredReasons: VerificationEvidenceReason[] = [];
  let verificationStatus: TaskCompletionVerificationStatus = receiptEvidence.configuredCommands.length === 0
    ? "not-applicable"
    : "verified";
  for (const candidate of receiptEvidence.candidates) {
    const status: TaskCompletionVerificationStatus = candidate.status === "passed" ? "verified"
      : candidate.status === "not-run" ? "not-applicable" : candidate.status;
    if (evidencePriority[status] > evidencePriority[verificationStatus]) verificationStatus = status;
    if (status !== "verified" && status !== "not-applicable") requiredReasons.push(candidate.reason);
  }

  const results = task?.workflowStepResults ?? [];
  const latestResultByStep = new Map<string, WorkflowStepResult>();
  for (const result of results) {
    if (result.phase === "post-merge") latestResultByStep.set(result.workflowStepId, result);
  }
  const requiredStepIds = new Set(context.requiredPostMergeStepIds ?? []);
  // A persisted `failed` (rather than `advisory_failure`) post-merge result is the graph's
  // existing gate authority even when a slim reader cannot resolve the workflow definition.
  for (const result of latestResultByStep.values()) {
    if (result.status === "failed" || result.status === "pending") requiredStepIds.add(result.workflowStepId);
  }
  for (const stepId of context.activeRequiredPostMergeStepIds ?? []) {
    requiredStepIds.add(stepId);
    if (evidencePriority.pending > evidencePriority[verificationStatus]) verificationStatus = "pending";
    requiredReasons.push("pending");
  }
  for (const stepId of requiredStepIds) {
    const result = latestResultByStep.get(stepId);
    if (!result) {
      if (evidencePriority.unavailable > evidencePriority[verificationStatus]) verificationStatus = "unavailable";
      requiredReasons.push("missing-receipt");
      continue;
    }
    if (result.status === "failed") {
      if (evidencePriority.failed > evidencePriority[verificationStatus]) verificationStatus = "failed";
      requiredReasons.push("failed-check");
    } else if (result.status === "pending") {
      if (evidencePriority.pending > evidencePriority[verificationStatus]) verificationStatus = "pending";
      requiredReasons.push("pending");
    } else if (result.status === "skipped" && !result.bypassedAt) {
      if (evidencePriority.unavailable > evidencePriority[verificationStatus]) verificationStatus = "unavailable";
      requiredReasons.push("not-run");
    }
  }
  const advisoryFailureStepIds = results
    .filter((result) => result.phase === "post-merge" && result.status === "advisory_failure")
    .map((result) => result.workflowStepId);
  return {
    landed: true,
    verifiedComplete: verificationStatus === "verified" || verificationStatus === "not-applicable",
    verificationStatus,
    requiredReasons: [...new Set(requiredReasons)],
    advisoryFailureStepIds,
    receiptEvidence,
  };
}
