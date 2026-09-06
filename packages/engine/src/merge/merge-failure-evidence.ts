/**
 * FNXC:MergeFailureEvidence 2026-09-06-05:15:
 * Preserve the original merge failure before awaited cleanup can hide it.
 * Emit fixed categories and source coordinates only, never error prose,
 * credentials, absolute paths, commands, task contents or model output.
 */
export type MergeFailureStage = "clean-room" | "dependencies" | "merge-review" | "squash-gates" | "candidate-verification" | "landing";

const kinds = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError"]);
const codes = new Set(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EBUSY", "ENOTEMPTY", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ABORT_ERR", "ERR_MODULE_NOT_FOUND"]);
const sources = new Set(["index.js", "index.mjs", "merger-ai.ts", "merger-ai.js", "pi.ts", "pi.js", "agent-session-helpers.ts", "agent-session-helpers.js", "resource-loader.js", "skills.js", "package-manager.js"]);

export function reportMergeFailure(error: unknown, stage: MergeFailureStage, write: (message: string) => void): void {
  try {
    const details = error instanceof Error ? error : undefined;
    const name = details?.name;
    const rawCode = details && "code" in details ? details.code : undefined;
    const message = details?.message.slice(0, 4096) ?? "";
    const category = /quota|rate.?limit|usage.?limit/i.test(message) ? "rate-limit"
      : /authenticat|unauthorized|credential|api.?key|oauth/i.test(message) ? "authentication"
      : /model.*(?:not found|unknown|unavailable|unsupported)|unknown model/i.test(message) ? "model-unavailable"
      : "other";
    const frames = (details?.stack ?? "").slice(0, 8192).split("\n").slice(1, 9).flatMap((line) => {
      const match = line.match(/(?:[/\\(])([A-Za-z0-9_.-]+\.(?:[cm]?js|ts)):(\d{1,9}):(\d{1,9})\)?$/);
      return match ? [{ source: sources.has(match[1]) ? match[1] : "other", line: Number(match[2]), column: Number(match[3]) }] : [];
    });
    write(`AI merge failure before cleanup: ${JSON.stringify({ stage, kind: kinds.has(name ?? "") ? name : "unknown", code: typeof rawCode === "string" && codes.has(rawCode) ? rawCode : "unknown", category, frames })}`);
  } catch {
    // FNXC:MergeFailureEvidence 2026-09-06-05:15: Diagnostics must not replace the original exception or interfere with cleanup, including hostile getters or a throwing logger.
  }
}
