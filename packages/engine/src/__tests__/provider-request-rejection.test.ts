import { describe, expect, it } from "vitest";
import { isOperatorActionableAgentError, isTransientError } from "../errors/transient-error-detector.js";

// FNXC:ProviderCompatibility 2026-09-05-08:30: the real tiny Spark smoke's 400
// must not become minute-long planner retries once local adaptation is exhausted.
describe("deterministic provider request rejection", () => {
  it.each([
    "Codex error: Unsupported parameter: 'reasoning.summary' is not supported with the 'gpt-5.3-codex-spark' model.",
    "Unknown parameter: reasoning.summary",
    "Invalid parameter: tools",
  ])("parks an unchanged invalid request: %s", (message) => {
    expect(isTransientError(message)).toBe(false);
    expect(isOperatorActionableAgentError(message)).toBe(true);
  });
  it("keeps connection failures transient", () => {
    expect(isTransientError("connection reset")).toBe(true);
    expect(isOperatorActionableAgentError("connection reset")).toBe(false);
  });
});
