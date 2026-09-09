import { afterEach, describe, expect, it, vi } from "vitest";

import { resetVerificationLimitRegistryForTests } from "../concurrency/verification-concurrency.js";
import { runVerificationCommand } from "../execution/verification-utils.js";

describe("verification wrapper queue receipts", () => {
  afterEach(() => {
    resetVerificationLimitRegistryForTests();
    vi.restoreAllMocks();
  });

  it("emits sanitized queued, running, and settled receipts without blocking verification", async () => {
    const backend = {
      capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" }),
      prepare: async () => {},
      run: vi.fn(),
      runStreaming: vi.fn().mockResolvedValue({ outcome: "success", stdout: "", stderr: "", bufferOverflow: false }),
      dispose: async () => {},
    } as any;
    const store = {
      logEntry: vi.fn().mockResolvedValue(undefined),
      appendAgentLog: vi.fn().mockResolvedValue(undefined),
      getWorkflowSettingsProjectId: () => "project-a",
    } as any;

    const result = await runVerificationCommand(
      store, "/tmp/project", "FN-QUEUE", "echo ok", "test", undefined,
      undefined, undefined, undefined, undefined, backend,
    );
    await Promise.resolve();

    expect(result.success).toBe(true);
    expect(store.logEntry.mock.calls.map(([_, text]: [string, string]) => text)).toEqual(expect.arrayContaining([
      expect.stringContaining("[verification-queue] state=queued; owner=merger"),
      expect.stringContaining("[verification-queue] state=running; owner=merger"),
      expect.stringContaining("[verification-queue] state=settled; owner=merger"),
    ]));
  });
});
