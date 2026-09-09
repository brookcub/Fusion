import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NativeSandboxBackend } from "../native.js";

const spawnMock = vi.hoisted(() => vi.fn());
const ownedCommandMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../windows-owned-command.js", () => ({
  runWindowsOwnedCommand: ownedCommandMock,
}));

class FakeChild extends EventEmitter {
  pid?: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn();

  constructor(pid = 1234) {
    super();
    this.pid = pid;
  }
}

describe("NativeSandboxBackend.runStreaming", () => {
  const processKillSpy = vi.spyOn(process, "kill");
  let platformSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    platformSpy = vi.spyOn(process, "platform", "get");
    platformSpy.mockReturnValue("linux");
  });

  afterEach(() => {
    vi.useRealTimers();
    platformSpy.mockRestore();
  });

  it("returns success result", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();

    const promise = backend.runStreaming("echo ok", { cwd: "/tmp", timeout: 1000, maxBuffer: 1024 });
    child.stdout.write("ok");
    child.stderr.write("warn");
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ outcome: "success", stdout: "ok", stderr: "warn", bufferOverflow: false });
  });

  it("returns non-zero-exit result", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();

    const promise = backend.runStreaming("exit 2", { cwd: "/tmp", timeout: 1000, maxBuffer: 1024 });
    child.emit("close", 2, null);

    await expect(promise).resolves.toMatchObject({ outcome: "non-zero-exit", exitCode: 2, signal: null });
  });

  it("returns timeout result and escalates SIGTERM then SIGKILL", async () => {
    const child = new FakeChild(4321);
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();

    const promise = backend.runStreaming("sleep", { cwd: "/tmp", timeout: 100, maxBuffer: 1024 });
    await vi.advanceTimersByTimeAsync(100);
    expect(processKillSpy).toHaveBeenCalledWith(-4321, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(processKillSpy).toHaveBeenCalledWith(-4321, "SIGKILL");
    child.emit("close", null, "SIGKILL");

    await expect(promise).resolves.toMatchObject({ outcome: "timeout", timeoutMs: 100 });
  });

  it("returns pre-start abort and does not spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    const backend = new NativeSandboxBackend();

    await expect(backend.runStreaming("echo", { cwd: "/tmp", timeout: 100, maxBuffer: 1024, signal: controller.signal }))
      .resolves.toEqual({ outcome: "aborted", phase: "pre-start", stdout: "", stderr: "" });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns mid-flight abort and escalates", async () => {
    const child = new FakeChild(2233);
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();
    const controller = new AbortController();

    const promise = backend.runStreaming("echo", { cwd: "/tmp", timeout: 1000, maxBuffer: 1024, signal: controller.signal });
    controller.abort();
    expect(processKillSpy).toHaveBeenCalledWith(-2233, "SIGTERM");
    await vi.advanceTimersByTimeAsync(5000);
    expect(processKillSpy).toHaveBeenCalledWith(-2233, "SIGKILL");
    child.emit("close", null, "SIGTERM");

    await expect(promise).resolves.toMatchObject({ outcome: "aborted", phase: "mid-flight" });
  });

  it("truncates stdout overflow", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();

    const promise = backend.runStreaming("echo", { cwd: "/tmp", timeout: 1000, maxBuffer: 5 });
    child.stdout.write("abcdef");
    child.stdout.write("ignored");
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ outcome: "success", stdout: "abcde", stderr: "", bufferOverflow: true });
  });

  it("truncates stderr overflow", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();

    const promise = backend.runStreaming("echo", { cwd: "/tmp", timeout: 1000, maxBuffer: 5 });
    child.stderr.write("abcdef");
    child.stderr.write("ignored");
    child.emit("close", 0, null);

    await expect(promise).resolves.toEqual({ outcome: "success", stdout: "", stderr: "abcde", bufferOverflow: true });
  });

  it("delegates win32 streaming to the owned-command adapter", async () => {
    platformSpy.mockReturnValue("win32");
    ownedCommandMock.mockResolvedValue({
      stdout: "owned", stderr: "", exitCode: 0, signal: null,
      timedOut: false, bufferExceeded: false, aborted: false,
    });
    const backend = new NativeSandboxBackend();

    await expect(backend.runStreaming("sleep", { cwd: "/tmp", timeout: 100, maxBuffer: 1024 }))
      .resolves.toEqual({ outcome: "success", stdout: "owned", stderr: "", bufferOverflow: false });
    expect(ownedCommandMock).toHaveBeenCalledWith("sleep", expect.objectContaining({
      cwd: "/tmp", timeoutMs: 100, maxBuffer: 1024,
    }), false);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("gives owned cleanup uncertainty precedence over cancellation", async () => {
    platformSpy.mockReturnValue("win32");
    const controller = new AbortController();
    ownedCommandMock.mockResolvedValue({
      stdout: "", stderr: "", exitCode: null, signal: null,
      timedOut: false, bufferExceeded: false, aborted: true,
      spawnError: new Error("cleanup unproven"),
    });

    await expect(new NativeSandboxBackend().runStreaming("sleep", {
      cwd: "/tmp", timeout: 100, maxBuffer: 1024, signal: controller.signal,
    })).resolves.toMatchObject({ outcome: "spawn-error", error: expect.any(Error) });
  });

  it("maps an owned cancellation to mid-flight abort", async () => {
    platformSpy.mockReturnValue("win32");
    ownedCommandMock.mockResolvedValue({
      stdout: "", stderr: "", exitCode: null, signal: null,
      timedOut: false, bufferExceeded: false, aborted: true,
    });

    await expect(new NativeSandboxBackend().runStreaming("sleep", { cwd: "/tmp", timeout: 100, maxBuffer: 1024 }))
      .resolves.toEqual({ outcome: "aborted", phase: "mid-flight", stdout: "", stderr: "" });
  });

  it("returns spawn-error", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child as any);
    const backend = new NativeSandboxBackend();
    const err = new Error("ENOENT");

    const promise = backend.runStreaming("missing", { cwd: "/tmp", timeout: 1000, maxBuffer: 1024 });
    child.emit("error", err);

    await expect(promise).resolves.toEqual({ outcome: "spawn-error", error: err, stdout: "", stderr: "" });
  });
});
