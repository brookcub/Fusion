import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { runVerificationCommand } from "../execution/run-verification-tool.js";
import type { SandboxBackend, SandboxStreamingResult } from "../sandbox/types.js";

describe("sandbox verification exit truth", () => {
  it.each([
    ["zero", { outcome: "success" }, false, true, true, false],
    ["unexpected zero", { outcome: "success" }, true, true, false, false],
    ["nonzero", { outcome: "non-zero-exit", exitCode: 9 }, false, false, false, false],
    ["expected nonzero", { outcome: "non-zero-exit", exitCode: 9 }, true, false, true, true],
    ["signal exit", { outcome: "non-zero-exit", exitCode: null, signal: "SIGTERM" }, true, false, false, false],
    ["timeout", { outcome: "timeout" }, true, false, false, false],
    ["abort", { outcome: "aborted" }, true, false, false, false],
    ["spawn failure", { outcome: "spawn-error", error: new Error("unavailable") }, true, false, false, false],
  ])("reports %s independently from expectation", async (_label, outcome, expectFailure, success, expectationMet, expectedFailureObserved) => {
    const backend = {
      prepare: vi.fn(),
      runStreaming: vi.fn().mockResolvedValue({ stdout: "", stderr: "", bufferOverflow: false, ...outcome } as SandboxStreamingResult),
    } as unknown as SandboxBackend;
    const result = await runVerificationCommand({
      command: "echo fixture", cwd: tmpdir(), timeoutMs: 1000,
      expectFailure: expectFailure as boolean, onHeartbeat: vi.fn(), sandboxBackend: backend,
    });
    expect(result).toMatchObject({ success, expectationMet, expectedFailureObserved });
  });
});
