import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMock = vi.hoisted(() => ({
  access: vi.fn(), mkdtemp: vi.fn(), readFile: vi.fn(), rm: vi.fn(), writeFile: vi.fn(),
}));
const superviseSpawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:fs/promises", () => fsMock);
vi.mock("@fusion/core", () => ({ superviseSpawn: superviseSpawnMock }));

import { performance } from "node:perf_hooks";
import { runWindowsOwnedCommand } from "../windows-owned-command.js";

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("runWindowsOwnedCommand failure containment", () => {
  let child: FakeChild;
  let kill: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    child = new FakeChild();
    kill = vi.fn();
    fsMock.mkdtemp.mockResolvedValue("C:/tmp/fusion-owned-command-test");
    fsMock.writeFile.mockResolvedValue(undefined);
    fsMock.access.mockResolvedValue(undefined);
    fsMock.rm.mockResolvedValue(undefined);
    fsMock.readFile.mockResolvedValue(JSON.stringify({ outcome: "exit", jobEmpty: true, exitCode: 0 }));
    superviseSpawnMock.mockReturnValue({ child, kill });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function run(signal?: AbortSignal) {
    return runWindowsOwnedCommand("echo safe", {
      cwd: "C:/tmp", timeoutMs: 100, maxBuffer: 1024, signal,
    });
  }

  it.each([
    ["missing", () => fsMock.readFile.mockRejectedValue(new Error("ENOENT"))],
    ["malformed", () => fsMock.readFile.mockResolvedValue("not-json")],
  ])("refuses a %s completion receipt", async (_name, arrange) => {
    arrange();
    const pending = run();
    await flush();
    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ spawnError: expect.any(Error) });
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it("refuses a helper-failure receipt even when the helper exits 125", async () => {
    fsMock.readFile.mockResolvedValue(JSON.stringify({ outcome: "helper-failure", jobEmpty: false, exitCode: 125 }));
    const pending = run();
    await flush();
    child.emit("close", 125);

    await expect(pending).resolves.toMatchObject({ spawnError: expect.any(Error) });
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it("fails closed when setup expires and a killed helper does not close", async () => {
    fsMock.access.mockRejectedValue(new Error("not ready"));
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(15_001);
    const pending = run();
    await flush();
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pending).resolves.toMatchObject({ spawnError: expect.any(Error) });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it.each([
    { outcome: "exit", jobEmpty: false, exitCode: 0 },
    { outcome: "timeout", jobEmpty: true, exitCode: 0 },
    { outcome: "cancelled", jobEmpty: true, exitCode: 0 },
    { outcome: "exit", jobEmpty: true, exitCode: 7 },
  ])("rejects contradictory completion $outcome/$exitCode/$jobEmpty", async (receipt) => {
    fsMock.readFile.mockResolvedValue(JSON.stringify(receipt));
    const pending = run();
    await flush();
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ spawnError: expect.any(Error), exitCode: null });
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it("preserves cleanup uncertainty when cancellation cannot be delivered", async () => {
    fsMock.writeFile.mockImplementation(async (path: string) => {
      if (path.endsWith("cancel")) throw new Error("unwritable");
    });
    fsMock.readFile.mockResolvedValue(JSON.stringify({ outcome: "exit", jobEmpty: true, exitCode: 0 }));
    const controller = new AbortController();
    const pending = run(controller.signal);
    await flush();
    controller.abort();
    await flush();
    child.emit("close", 0);
    await expect(pending).resolves.toMatchObject({ spawnError: expect.any(Error), aborted: true, exitCode: null });
    expect(fsMock.rm).not.toHaveBeenCalled();
  });

  it("fails closed when cancellation cleanup exceeds its bounded window", async () => {
    const times = [0, 1, 2, 3, 5_004];
    vi.spyOn(performance, "now").mockImplementation(() => times.shift() ?? 5_004);
    const controller = new AbortController();
    const pending = run(controller.signal);
    await flush();
    controller.abort();
    await vi.advanceTimersByTimeAsync(1_050);

    await expect(pending).resolves.toMatchObject({ aborted: true, spawnError: expect.any(Error) });
    expect(kill).toHaveBeenCalledWith("SIGKILL");
    expect(fsMock.rm).not.toHaveBeenCalled();
  });
});
