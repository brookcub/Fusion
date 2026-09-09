import { expect, it } from "vitest";
import { getTaskCompletionEvidenceBadge } from "../taskProgress";

it.each([
  ["failed", "verification-failed"],
  ["pending", "verification-pending"],
  ["stale", "verification-stale"],
  ["unavailable", "verification-unavailable"],
] as const)("presents landed required %s evidence without claiming verification", (verificationStatus, testId) => {
  expect(getTaskCompletionEvidenceBadge({ completionEvidence: {
    landed: true, verifiedComplete: false, verificationStatus, requiredReasons: [], advisoryFailureStepIds: [], receiptEvidence: { mergeConfirmed: true, configuredCommands: [], candidates: [] },
  } })).toMatchObject({ testId });
});

it("keeps advisory failures visible but non-blocking", () => {
  expect(getTaskCompletionEvidenceBadge({ completionEvidence: {
    landed: true, verifiedComplete: true, verificationStatus: "verified", requiredReasons: [], advisoryFailureStepIds: ["advisory"], receiptEvidence: { mergeConfirmed: true, configuredCommands: [], candidates: [] },
  } })).toMatchObject({ testId: "verification-advisory" });
});
