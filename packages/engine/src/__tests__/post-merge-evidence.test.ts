import { expect, it } from "vitest";
import type { Task } from "@fusion/core";
import { buildPostMergeEvidence, verificationHash, verificationSettingsHash } from "../merge/merge-verification-evidence.js";

const settings = { testCommand: "node check-fixture.mjs" };
const sha = "a".repeat(40), source = "b".repeat(40);
function fixture() {
  return { mergeDetails: { mergeConfirmed: true, commitSha: sha, landedBranchTipSha: source,
    verificationReceipts: [{ schema: 1, candidateSha: sha, sourceSha: source,
      settingsSha256: verificationSettingsHash(settings), startedAt: "2026-09-06T06:00:00Z",
      completedAt: "2026-09-06T06:00:01Z", outcome: "passed",
      checks: [{ type: "test", commandSha256: verificationHash(settings.testCommand), exitCode: 0 }] }] },
    log: [{ message: "old check failed" }] } as unknown as Task;
}
const evidence = (task: Task, config = settings) => JSON.parse(buildPostMergeEvidence(task, config).split("\n")[1]!);
it("delivers the landed candidate's result rather than an old failure or model text", () => {
  const task = fixture();
  expect(evidence(task).candidates).toMatchObject([{ candidateSha: sha, status: "passed", checks: [{ exitCode: 0 }] }]);
  expect(buildPostMergeEvidence(task, settings)).not.toContain("old check failed");
});
it.each(["candidate", "source", "settings", "command", "pending", "nonzero", "malformed", "missing"])("classifies non-current evidence without claiming success for %s", kind => {
  const task = fixture(), r = task.mergeDetails!.verificationReceipts![0]!;
  if (kind === "candidate") r.candidateSha = "c".repeat(40);
  if (kind === "source") r.sourceSha = "c".repeat(40);
  if (kind === "settings") r.settingsSha256 = "c".repeat(64);
  if (kind === "command") r.checks[0]!.commandSha256 = "c".repeat(64);
  if (kind === "pending") r.outcome = "pending";
  if (kind === "nonzero") (r.checks[0] as any).exitCode = 1;
  if (kind === "malformed") (r as any).checks = {};
  if (kind === "missing") task.mergeDetails!.verificationReceipts = undefined;
  expect(evidence(task).candidates[0].status).toBe(kind === "nonzero" ? "failed" : ["source", "settings", "command"].includes(kind) ? "stale" : "unavailable");
});
it("does not let a previous passing attempt hide a later incomplete attempt", () => {
  const task = fixture();
  task.mergeDetails!.verificationReceipts!.push({ ...task.mergeDetails!.verificationReceipts![0]!, outcome: "pending" });
  expect(evidence(task).candidates[0].status).toBe("unavailable");
});
it("distinguishes no commands from a passing check", () => {
  const task = fixture(), r = task.mergeDetails!.verificationReceipts![0]!;
  r.settingsSha256 = verificationSettingsHash({}); r.checks = []; r.outcome = "not-run";
  expect(evidence(task, {} as any).candidates[0].status).toBe("not-run");
});
it("requires coverage of every workspace landing", () => {
  const task = fixture(); task.mergeDetails!.workspaceLandedShas = { one: sha, two: "c".repeat(40) };
  expect(evidence(task).candidates.map((r: any) => r.status)).toEqual(["passed", "unavailable"]);
});
it("does not share one passing check between repositories at the same commit", () => {
  const task = fixture(); task.mergeDetails!.workspaceLandedShas = { one: sha, two: sha };
  expect(evidence(task).candidates).toMatchObject([
    { repository: "one", candidateSha: sha, status: "unavailable" },
    { repository: "two", candidateSha: sha, status: "unavailable" },
  ]);
});
