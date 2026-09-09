import { expect, it } from "vitest";
import type { Task } from "../types.js";
import { verificationHash, verificationSettingsHash } from "../merge/verification-evidence.js";
import { deriveTaskCompletionEvidence } from "../tasks/task-completion-evidence.js";

const sha = "a".repeat(40);
const source = "b".repeat(40);
const settings = { testCommand: "node check-fixture.mjs" };

function task(): Task {
  return {
    id: "FIXTURE-COMPLETION", projectId: "isolated", description: "synthetic", column: "done", status: "completed", priority: "normal",
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z", steps: [], log: [], workflowStepResults: [],
    mergeDetails: { mergeConfirmed: true, commitSha: sha, landedBranchTipSha: source, verificationReceipts: [{
      schema: 1, candidateSha: sha, sourceSha: source, settingsSha256: verificationSettingsHash(settings),
      startedAt: "2026-09-09T00:00:00.000Z", completedAt: "2026-09-09T00:00:01.000Z", outcome: "passed",
      checks: [{ type: "test", commandSha256: verificationHash(settings.testCommand), exitCode: 0 }],
    }] },
  } as Task;
}

it.each([
  ["settled current evidence", (value: Task) => value, {}, "verified", true],
  ["required failed post-merge gate", (value: Task) => { value.workflowStepResults = [{ workflowStepId: "post", phase: "post-merge", status: "failed" } as any]; return value; }, { requiredPostMergeStepIds: ["post"] }, "failed", false],
  ["missing required post-merge gate", (value: Task) => value, { requiredPostMergeStepIds: ["post"] }, "unavailable", false],
  ["active required post-merge work", (value: Task) => value, { activeRequiredPostMergeStepIds: ["post"] }, "pending", false],
  ["stale receipt", (value: Task) => { value.mergeDetails!.verificationReceipts![0]!.settingsSha256 = "c".repeat(64); return value; }, {}, "stale", false],
] as const)("does not present %s as verified completion", (_name, arrange, context, status, verifiedComplete) => {
  const evidence = deriveTaskCompletionEvidence(arrange(task()), settings, context);
  expect(evidence).toMatchObject({ landed: true, verificationStatus: status, verifiedComplete });
});

it("keeps advisory post-merge failures visible and non-blocking", () => {
  const value = task();
  value.workflowStepResults = [{ workflowStepId: "advisory", phase: "post-merge", status: "advisory_failure" } as any];
  expect(deriveTaskCompletionEvidence(value, settings)).toMatchObject({
    landed: true, verificationStatus: "verified", verifiedComplete: true, advisoryFailureStepIds: ["advisory"],
  });
});

it("does not invent a passing verification result when no commands are configured", () => {
  const value = task();
  value.mergeDetails!.verificationReceipts![0] = { ...value.mergeDetails!.verificationReceipts![0]!, settingsSha256: verificationSettingsHash({}), outcome: "not-run", checks: [] };
  expect(deriveTaskCompletionEvidence(value, {})).toMatchObject({ verificationStatus: "not-applicable", verifiedComplete: true });
});
