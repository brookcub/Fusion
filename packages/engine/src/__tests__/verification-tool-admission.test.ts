import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxBackend } from "../sandbox/types.js";
import { createRunVerificationTool, runVerificationCommand } from "../execution/run-verification-tool.js";
import { getVerificationQueueSnapshot, getVerificationSemaphore, withVerificationSlot } from "../concurrency/verification-concurrency.js";

const nativeSpawn = vi.hoisted(() => vi.fn());
vi.mock("@fusion/core", async (load) => ({ ...await load<typeof import("@fusion/core")>(), superviseSpawn: nativeSpawn }));

function backend(overrides: Partial<SandboxBackend> = {}): SandboxBackend {
  return {
    capabilities: () => ({ id: "native", supportsNetworkPolicy: false, supportsFilesystemPolicy: false, supportsStreaming: true, platform: "any" }),
    prepare: vi.fn(async () => {}), run: vi.fn(),
    runStreaming: vi.fn(async () => ({ outcome: "success" as const, stdout: "", stderr: "", bufferOverflow: false })),
    dispose: async () => {}, ...overrides,
  };
}

function toolOptions(sandboxBackend: SandboxBackend) {
  return { worktreePath: process.cwd(), rootDir: process.cwd(), taskId: "FN-QUEUE-TOOL", projectId: "project-a",
    sandboxBackend, recordActivity: vi.fn(), log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
}

describe("verification tool admission and cancellation", () => {
  afterEach(() => {
    expect(getVerificationSemaphore().activeCount).toBe(0);
    expect(getVerificationSemaphore().waitingCount).toBe(0);
    expect(getVerificationQueueSnapshot().active).toEqual([]);
    vi.useRealTimers();
    vi.restoreAllMocks();
    nativeSpawn.mockReset();
  });

  it("publishes queued before admission and cancels without starting a backend", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withVerificationSlot(async () => gate);
    let queued!: () => void;
    const seenQueued = new Promise<void>((resolve) => { queued = resolve; });
    const states: string[] = [];
    const sandbox = backend();
    const controller = new AbortController();
    const start = vi.fn(); const end = vi.fn();
    const tool = createRunVerificationTool({ ...toolOptions(sandbox),
      onVerificationStart: start, onVerificationEnd: end,
      onVerificationState: (receipt) => { states.push(receipt.state); if (receipt.state === "queued") queued(); },
    });
    const pending = tool.execute("call", { command: "exit 0", scope: "package" }, controller.signal);
    try {
      await seenQueued;
      expect(getVerificationQueueSnapshot("project-a").active).toMatchObject([{ state: "queued", taskId: "FN-QUEUE-TOOL" }]);
      expect(start).not.toHaveBeenCalled();
      const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
      controller.abort();
      await rejected;
      expect(sandbox.prepare).not.toHaveBeenCalled();
      expect(sandbox.runStreaming).not.toHaveBeenCalled();
      expect(states).toEqual(["queued", "settled"]);
      expect(end).toHaveBeenCalledOnce();
    } finally { release(); await holder; }
  });

  it("only marks running after admission and preserves real-model tool cancellation into backend", async () => {
    const controller = new AbortController();
    const start = vi.fn(); const end = vi.fn();
    const sandbox = backend({ runStreaming: vi.fn(async (_command, options) => {
      expect(start).toHaveBeenCalledOnce();
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return { outcome: "aborted", stdout: "", stderr: "", bufferOverflow: false };
    }) });
    const tool = createRunVerificationTool({ ...toolOptions(sandbox), onVerificationStart: start, onVerificationEnd: end });
    await expect(tool.execute("call", { command: "exit 0", scope: "package" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(end).toHaveBeenCalledOnce();
  });

  it("keeps cancellation across workspace fan-out and never starts the second repository", async () => {
    const controller = new AbortController();
    const sandbox = backend({ runStreaming: vi.fn(async (_command, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort();
      return { outcome: "aborted", stdout: "", stderr: "", bufferOverflow: false };
    }) });
    const tool = createRunVerificationTool({ ...toolOptions(sandbox), workspaceRepos: [
      { repo: "a", worktreePath: process.cwd(), modified: true },
      { repo: "b", worktreePath: process.cwd(), modified: true },
    ] });
    await expect(tool.execute("call", { command: "exit 0", scope: "package" }, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(sandbox.runStreaming).toHaveBeenCalledOnce();
  });

  it("does not launch after cancellation during backend preparation", async () => {
    const controller = new AbortController();
    const sandbox = backend({ prepare: vi.fn(async () => { controller.abort(); }) });
    await expect(runVerificationCommand({ command: "exit 0", cwd: process.cwd(), timeoutMs: 100,
      onHeartbeat: vi.fn(), signal: controller.signal, sandboxBackend: sandbox,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(sandbox.runStreaming).not.toHaveBeenCalled();
  });

  it("native cancellation kills its owned child and rejects even if close reports zero", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    let spawned!: () => void;
    const seenSpawn = new Promise<void>((resolve) => { spawned = resolve; });
    const kill = vi.fn(() => { queueMicrotask(() => child.emit("close", 0, null)); });
    nativeSpawn.mockImplementation(() => { spawned(); return { child, kill }; });
    const controller = new AbortController();
    const pending = runVerificationCommand({ command: "fixture-command", cwd: process.cwd(), timeoutMs: 100,
      onHeartbeat: vi.fn(), signal: controller.signal,
    });
    await seenSpawn;
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await vi.runAllTimersAsync();
    await rejected;
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(nativeSpawn).toHaveBeenCalledOnce();
  });
});
