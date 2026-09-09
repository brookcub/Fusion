import type { Settings, Task } from "@fusion/core";
import {
  classifyMergeVerificationEvidence,
  verificationHash,
  verificationSettingsHash,
} from "@fusion/core";

export { verificationHash, verificationSettingsHash };

/**
 * FNXC:MergeEvidence 2026-09-09-03:59:
 * Prompt formatting remains an engine concern, while receipt identity and outcome classification
 * are core-owned so public completion reads and post-merge prompts cannot disagree about a failed,
 * stale, unavailable, or not-run candidate check.
 */
export function buildPostMergeEvidence(task: Task | null | undefined, settings: Settings): string {
  const evidence = classifyMergeVerificationEvidence(task, settings);
  return `## Engine-owned landed verification evidence\n${JSON.stringify(evidence)}\nThese are pre-landing checks of the exact recorded landed candidate, not fresh post-landing executions. Matching passed receipts supersede earlier failures only for the same command and candidate. Historical logs or summaries can describe older attempts. Unavailable or not-run evidence is never a passing check. Inspect the merged result for remaining defects; this receipt does not dictate your verdict.`;
}
