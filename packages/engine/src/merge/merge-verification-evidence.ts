import { createHash } from "node:crypto";
import type { Settings, Task } from "@fusion/core";

export const verificationHash = (value: string): string => createHash("sha256").update(value).digest("hex");
export function verificationSettingsHash(settings: Settings): string {
  return verificationHash(JSON.stringify([settings.testCommand?.trim(), settings.buildCommand?.trim(),
    settings.verificationCommandTimeoutMs, settings.scopeVerificationToChangedFiles]));
}

/** FNXC:MergeEvidence 2026-09-06-06:00: Readonly post-merge agents receive current, candidate-bound proof explicitly. Old output is history, not an authority for the landed candidate; missing/mismatched proof stays unavailable. */
export function buildPostMergeEvidence(task: Task | null | undefined, settings: Settings): string {
  const details = task?.mergeDetails;
  const landings = details?.workspaceLandedShas && Object.keys(details.workspaceLandedShas).length
    ? Object.entries(details.workspaceLandedShas).map(([repository, sha]) => ({ repository, sha }))
    : [{ repository: ".", sha: details?.commitSha }];
  const shas = landings.map(x => x.sha);
  const expected = ([{ type: "test", command: settings.testCommand?.trim() },
    { type: "build", command: settings.buildCommand?.trim() }] as const).filter(x => x.command);
  const hex40 = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{40}$/i.test(x);
  const hex64 = (x: unknown): x is string => typeof x === "string" && /^[a-f0-9]{64}$/i.test(x);
  const proof = details?.mergeConfirmed === true && shas.every(hex40);
  const receipts = Array.isArray(details?.verificationReceipts) ? details.verificationReceipts : [];
  const candidates = proof ? landings.map(({ repository, sha }) => {
    const receipt = receipts.findLast(r => r?.candidateSha === sha);
    // FNXC:MergeEvidence 2026-09-06-06:00: Shared commits do not prove checks in two different repositories. Until receipts have repository identity, ambiguous workspace SHA aliases remain unavailable.
    const valid = shas.filter(value => value === sha).length === 1
      && receipt?.schema === 1 && hex40(receipt.sourceSha)
      && (!details?.landedBranchTipSha || shas.length !== 1 || receipt.sourceSha === details.landedBranchTipSha)
      && receipt.settingsSha256 === verificationSettingsHash(settings)
      && typeof receipt.startedAt === "string" && typeof receipt.completedAt === "string"
      && Number.isFinite(Date.parse(receipt.startedAt)) && Number.isFinite(Date.parse(receipt.completedAt))
      && Date.parse(receipt.completedAt) >= Date.parse(receipt.startedAt)
      && Array.isArray(receipt.checks) && receipt.checks.every(c => c && (c.type === "test" || c.type === "build")
        && hex64(c.commandSha256) && c.exitCode === 0)
      && expected.every(e => receipt.checks.some(c => c.type === e.type && c.commandSha256 === verificationHash(e.command!)))
      && ((receipt.outcome === "passed" && receipt.checks.length > 0)
        || (receipt.outcome === "not-run" && receipt.checks.length === 0 && expected.length === 0));
    return valid ? { repository, candidateSha: sha, evidence: receipt.outcome, completedAt: receipt.completedAt,
      checks: receipt.checks.map(c => ({ type: c.type, commandSha256: c.commandSha256, exitCode: c.exitCode })) }
      : { repository, candidateSha: sha, evidence: "unavailable" };
  }) : [];
  return `## Engine-owned landed verification evidence\n${JSON.stringify({
    mergeConfirmed: proof, configuredCommands: expected.map(e => ({ type: e.type, commandSha256: verificationHash(e.command!) })), candidates,
  })}\nThese are pre-landing checks of the exact recorded landed candidate, not fresh post-landing executions. Matching passed receipts supersede earlier failures only for the same command and candidate. Historical logs or summaries can describe older attempts. Unavailable or not-run evidence is never a passing check. Inspect the merged result for remaining defects; this receipt does not dictate your verdict.`;
}
