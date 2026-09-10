import { createHash } from "node:crypto";
import type { Settings, Task } from "../types.js";

export type VerificationEvidenceStatus = "passed" | "failed" | "stale" | "unavailable" | "not-run";
export type VerificationEvidenceReason =
  | "merge-unconfirmed"
  | "missing-receipt"
  | "missing-settings"
  | "pending"
  | "candidate-mismatch"
  | "source-mismatch"
  | "settings-mismatch"
  | "command-mismatch"
  | "malformed-receipt"
  | "ambiguous-workspace-candidate"
  | "failed-check"
  | "current-pass"
  | "not-run";

export type MergeVerificationCandidateEvidence = {
  repository: string;
  candidateSha: string;
  status: VerificationEvidenceStatus;
  reason: VerificationEvidenceReason;
  completedAt?: string;
  checks?: Array<{ type: "test" | "build"; commandSha256: string; exitCode: number; failureKind?: "nonzero" | "timeout" | "aborted" | "execution-error" | "cached" }>;
};

export type MergeVerificationEvidence = {
  mergeConfirmed: boolean;
  configuredCommands: Array<{ type: "test" | "build"; commandSha256: string }>;
  candidates: MergeVerificationCandidateEvidence[];
};

export const verificationHash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function verificationSettingsHash(settings: Pick<Settings, "testCommand" | "buildCommand" | "verificationCommandTimeoutMs" | "scopeVerificationToChangedFiles">): string {
  return verificationHash(JSON.stringify([
    settings.testCommand?.trim(),
    settings.buildCommand?.trim(),
    settings.verificationCommandTimeoutMs,
    settings.scopeVerificationToChangedFiles,
  ]));
}

const hex40 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{40}$/i.test(value);
const hex64 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);

/**
 * FNXC:VerificationEvidence 2026-09-09-16:00:
 * Receipt truth is derived from the exact landed candidate and effective settings. A failed
 * current command remains failed; identity drift is stale; absent or still-running proof is
 * unavailable. A current pass has its own actionable reason rather than borrowing the not-run
 * diagnostic. This pure authority deliberately does not infer workflow policy or persist state.
 */
export function classifyMergeVerificationEvidence(
  task: Pick<Task, "mergeDetails"> | null | undefined,
  settings: Pick<Settings, "testCommand" | "buildCommand" | "verificationCommandTimeoutMs" | "scopeVerificationToChangedFiles"> | null | undefined,
): MergeVerificationEvidence {
  const details = task?.mergeDetails;
  const landings = details?.workspaceLandedShas && Object.keys(details.workspaceLandedShas).length > 0
    ? Object.entries(details.workspaceLandedShas).map(([repository, candidateSha]) => ({ repository, candidateSha }))
    : [{ repository: ".", candidateSha: details?.commitSha }];
  const mergeConfirmed = details?.mergeConfirmed === true && landings.every(({ candidateSha }) => hex40(candidateSha));
  const configuredCommands = settings ? ([
    { type: "test" as const, command: settings.testCommand?.trim() },
    { type: "build" as const, command: settings.buildCommand?.trim() },
  ].filter((entry): entry is { type: "test" | "build"; command: string } => Boolean(entry.command))
    .map(({ type, command }) => ({ type, commandSha256: verificationHash(command) }))) : [];
  if (!mergeConfirmed) return { mergeConfirmed: false, configuredCommands, candidates: [] };

  const receipts = Array.isArray(details?.verificationReceipts) ? details.verificationReceipts : [];
  const settingsHash = settings ? verificationSettingsHash(settings) : undefined;
  return {
    mergeConfirmed,
    configuredCommands,
    candidates: landings.map(({ repository, candidateSha }) => {
      const sameCandidate = [...receipts]
        .filter((receipt) => receipt?.candidateSha === candidateSha)
        // A late settlement from an older attempt must not replace a newer pending or failed attempt.
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
      const receipt = sameCandidate.at(-1);
      if (!receipt) return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "missing-receipt" };
      if (landings.filter((landing) => landing.candidateSha === candidateSha).length > 1) {
        return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "ambiguous-workspace-candidate" };
      }
      if (receipt.schema !== 1 || !hex40(receipt.sourceSha) || !hex64(receipt.settingsSha256)
        || typeof receipt.startedAt !== "string" || !Number.isFinite(Date.parse(receipt.startedAt))
        || !Array.isArray(receipt.checks)) {
        return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "malformed-receipt" };
      }
      if (receipt.outcome === "pending") return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "pending" };
      if (!settings) return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "missing-settings" };
      if (details?.landedBranchTipSha && landings.length === 1 && receipt.sourceSha !== details.landedBranchTipSha) {
        return { repository, candidateSha: candidateSha!, status: "stale", reason: "source-mismatch" };
      }
      if (receipt.settingsSha256 !== settingsHash) return { repository, candidateSha: candidateSha!, status: "stale", reason: "settings-mismatch" };
      if (typeof receipt.completedAt !== "string" || !Number.isFinite(Date.parse(receipt.completedAt))
        || Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
        return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "malformed-receipt" };
      }
      const checks = receipt.checks;
      if (!checks.every((check) => check && (check.type === "test" || check.type === "build")
        && hex64(check.commandSha256) && Number.isInteger(check.exitCode))) {
        return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "malformed-receipt" };
      }
      if (!configuredCommands.every((expected) => checks.some((check) => check.type === expected.type && check.commandSha256 === expected.commandSha256))) {
        return { repository, candidateSha: candidateSha!, status: "stale", reason: "command-mismatch" };
      }
      const result = { repository, candidateSha: candidateSha!, completedAt: receipt.completedAt, checks };
      if (receipt.outcome === "failed" || checks.some((check) => check.exitCode !== 0 || check.failureKind)) {
        return { ...result, status: "failed" as const, reason: "failed-check" as const };
      }
      if (receipt.outcome === "not-run" && checks.length === 0 && configuredCommands.length === 0) {
        return { ...result, status: "not-run" as const, reason: "not-run" as const };
      }
      if (receipt.outcome === "passed" && checks.length > 0) return { ...result, status: "passed" as const, reason: "current-pass" as const };
      return { repository, candidateSha: candidateSha!, status: "unavailable", reason: "malformed-receipt" };
    }),
  };
}
