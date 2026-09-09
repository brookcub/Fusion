import { expect, it } from "vitest";
import type { Task } from "../types.js";
import {
  classifyMergeVerificationEvidence,
  verificationHash,
  verificationSettingsHash,
} from "../merge/verification-evidence.js";

const sha = "a".repeat(40);
const source = "b".repeat(40);
const settings = { testCommand: "node check-fixture.mjs" };

function fixture(): Task {
  return {
    id: "FIXTURE-COMPLETION",
    projectId: "test-project",
    description: "synthetic completion evidence",
    column: "done",
    status: "completed",
    priority: "normal",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:00:00.000Z",
    steps: [],
    log: [],
    mergeDetails: {
      mergeConfirmed: true,
      commitSha: sha,
      landedBranchTipSha: source,
      verificationReceipts: [{
        schema: 1,
        candidateSha: sha,
        sourceSha: source,
        settingsSha256: verificationSettingsHash(settings),
        startedAt: "2026-09-09T00:00:00.000Z",
        completedAt: "2026-09-09T00:00:01.000Z",
        outcome: "passed",
        checks: [{ type: "test", commandSha256: verificationHash(settings.testCommand), exitCode: 0 }],
      }],
    },
  } as Task;
}

it.each([
  ["current pass", (task: Task) => task, "passed"],
  ["required failure", (task: Task) => { task.mergeDetails!.verificationReceipts![0]!.outcome = "failed"; task.mergeDetails!.verificationReceipts![0]!.checks[0]!.exitCode = 1; return task; }, "failed"],
  ["changed settings", (task: Task) => task, "stale", { testCommand: "node changed-check.mjs" }],
  ["pending replacement", (task: Task) => { task.mergeDetails!.verificationReceipts!.push({ ...task.mergeDetails!.verificationReceipts![0]!, outcome: "pending", completedAt: undefined, checks: [] }); return task; }, "unavailable"],
  ["missing receipt", (task: Task) => { task.mergeDetails!.verificationReceipts = []; return task; }, "unavailable"],
] as const)("classifies %s evidence without promoting stale success", (_name, arrange, status, effectiveSettings = settings) => {
  const evidence = classifyMergeVerificationEvidence(arrange(fixture()), effectiveSettings);
  expect(evidence.candidates).toMatchObject([{ candidateSha: sha, status }]);
});

it("does not let a late older settlement erase a newer required failure", () => {
  const task = fixture();
  task.mergeDetails!.verificationReceipts!.push({
    ...task.mergeDetails!.verificationReceipts![0]!,
    startedAt: "2026-09-09T00:00:02.000Z",
    completedAt: "2026-09-09T00:00:03.000Z",
    outcome: "failed",
    checks: [{ type: "test", commandSha256: verificationHash(settings.testCommand), exitCode: 1, failureKind: "nonzero" }],
  });
  expect(classifyMergeVerificationEvidence(task, settings).candidates).toMatchObject([{ status: "failed" }]);
});

it("reports no commands as not-run rather than a passing check", () => {
  const task = fixture();
  task.mergeDetails!.verificationReceipts![0] = {
    ...task.mergeDetails!.verificationReceipts![0]!,
    settingsSha256: verificationSettingsHash({}),
    outcome: "not-run",
    checks: [],
  };
  expect(classifyMergeVerificationEvidence(task, {}).candidates).toMatchObject([{ status: "not-run" }]);
});
