import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  clampMaxConcurrentVerifications,
  getMaxConcurrentVerifications,
  getVerificationSemaphore,
  getVerificationQueueSnapshot,
  MAX_CONCURRENT_VERIFICATIONS_HARD_CAP,
  registerProjectVerificationLimit,
  resetVerificationLimitRegistryForTests,
  setMaxConcurrentVerifications,
  unregisterProjectVerificationLimit,
  withVerificationSlot,
} from "../concurrency/verification-concurrency.js";

describe("verification concurrency", () => {
  beforeEach(() => {
    expect(getVerificationSemaphore().activeCount).toBe(0);
    expect(getVerificationSemaphore().waitingCount).toBe(0);
    resetVerificationLimitRegistryForTests();
    setMaxConcurrentVerifications(1);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    expect(getVerificationSemaphore().activeCount).toBe(0);
    expect(getVerificationSemaphore().waitingCount).toBe(0);
    expect(getVerificationQueueSnapshot().active).toEqual([]);
  });

  it("defaults to one concurrent verification", () => {
    expect(getMaxConcurrentVerifications()).toBe(1);
  });

  it("clamps limit to 1–8", () => {
    expect(clampMaxConcurrentVerifications(0)).toBe(1);
    expect(clampMaxConcurrentVerifications(-3)).toBe(1);
    expect(clampMaxConcurrentVerifications(50)).toBe(MAX_CONCURRENT_VERIFICATIONS_HARD_CAP);
    expect(clampMaxConcurrentVerifications(3.9)).toBe(3);
    setMaxConcurrentVerifications(99);
    expect(getMaxConcurrentVerifications()).toBe(8);
  });

  it("uses the minimum of registered project limits (most restrictive wins)", () => {
    registerProjectVerificationLimit("proj-a", 8);
    registerProjectVerificationLimit("proj-b", 1);
    expect(getMaxConcurrentVerifications()).toBe(1);
    unregisterProjectVerificationLimit("proj-b");
    expect(getMaxConcurrentVerifications()).toBe(8);
    unregisterProjectVerificationLimit("proj-a");
    setMaxConcurrentVerifications(2);
    expect(getMaxConcurrentVerifications()).toBe(2);
  });

  it("serializes overlapping withVerificationSlot callers when limit is 1", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withVerificationSlot(async () => {
      order.push("first-enter");
      await firstGate;
      order.push("first-exit");
    });

    // Let first acquire the slot.
    await Promise.resolve();
    await Promise.resolve();

    const second = withVerificationSlot(async () => {
      order.push("second");
    });

    // Second must not run while first holds the only slot.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first-enter"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-enter", "first-exit", "second"]);
  });

  it("allows two concurrent slots when limit is 2", async () => {
    setMaxConcurrentVerifications(2);
    let concurrent = 0;
    let peak = 0;

    await Promise.all(
      [1, 2].map(() =>
        withVerificationSlot(async () => {
          concurrent++;
          peak = Math.max(peak, concurrent);
          await new Promise((r) => setTimeout(r, 20));
          concurrent--;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it("rejects with AbortError when aborted while queued for a slot", async () => {
    setMaxConcurrentVerifications(1);
    let releaseHolder!: () => void;
    const holderGate = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });

    const holder = withVerificationSlot(async () => {
      await holderGate;
    });
    await Promise.resolve();
    await Promise.resolve();

    const ac = new AbortController();
    const waiting = withVerificationSlot(async () => "ran", ac.signal);
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    releaseHolder();
    await holder;
  });

  it("records bounded queue lifecycle and prevents a timed-out waiter from running", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const holder = withVerificationSlot(async () => await new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve(); await Promise.resolve();
    let ran = false;
    const waiting = withVerificationSlot(async () => { ran = true; }, {
      taskId: "FN-QUEUE", ownerKind: "merger", queueTimeoutMs: 10,
    });
    expect(getVerificationQueueSnapshot().active).toMatchObject([{ taskId: "FN-QUEUE", ownerKind: "merger", state: "queued" }]);
    const rejected = expect(waiting).rejects.toMatchObject({ name: "VerificationQueueTimeoutError" });
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    expect(ran).toBe(false);
    expect(getVerificationQueueSnapshot().active).toEqual([]);
    expect(getVerificationQueueSnapshot().settled).toMatchObject([{ taskId: "FN-QUEUE", state: "settled", outcome: "queue-timeout" }]);
    release(); await holder;
  });

  it("does not let a hung or throwing observer hold admission, and emits settled", async () => {
    const states: string[] = [];
    await withVerificationSlot(async () => "ok", {
      taskId: "FN-OBS", ownerKind: "executor", queueTimeoutMs: 100,
      onState: (receipt) => { states.push(receipt.state); if (receipt.state === "queued") return new Promise<void>(() => {}); if (receipt.state === "running") throw new Error("observer"); },
    });
    await Promise.resolve();
    expect(states).toEqual(expect.arrayContaining(["queued", "running", "settled"]));
    expect(getVerificationQueueSnapshot().active).toEqual([]);
  });

  it.each([false, true])("refuses an already aborted caller before admission (legacy=%s)", async (legacy) => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => "must not run");
    await expect(withVerificationSlot(fn, legacy ? controller.signal : {
      signal: controller.signal, taskId: "FN-CANCEL", ownerKind: "merger",
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("releases exactly once when abort races an immediately acquired slot", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => "must not run");
    const waiting = withVerificationSlot(fn, { signal: controller.signal, taskId: "FN-RACE", ownerKind: "merger" });
    expect(getVerificationSemaphore().activeCount).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).not.toHaveBeenCalled();
    expect(getVerificationSemaphore().activeCount).toBe(0);
    expect(getVerificationQueueSnapshot().settled.at(-1)?.outcome).toBe("cancelled");
    await expect(withVerificationSlot(async () => "next")).resolves.toBe("next");
  });

  it("honors cancellation requested by the running observer before executing", async () => {
    const controller = new AbortController();
    const fn = vi.fn(async () => "must not run");
    await expect(withVerificationSlot(fn, {
      signal: controller.signal, taskId: "FN-OBS-CANCEL", ownerKind: "merger",
      onState: (receipt) => { if (receipt.state === "running") controller.abort(); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("expires only the queue timer, not an admitted command", async () => {
    vi.useFakeTimers();
    await expect(withVerificationSlot(async () => {
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1_000);
      return "finished";
    }, { taskId: "FN-LONG", ownerKind: "executor", queueTimeoutMs: 10 })).resolves.toBe("finished");
    expect(getVerificationQueueSnapshot().settled.at(-1)?.outcome).toBe("completed");
  });

  it("keeps concurrent attempts distinct and project-filters immutable snapshots", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const config = { taskId: "FN-SAME", ownerKind: "merger" as const, projectId: "project-a" };
    const first = withVerificationSlot(async () => gate, config);
    await Promise.resolve();
    const second = withVerificationSlot(async () => "second", config);
    const third = withVerificationSlot(async () => "third", { ...config, projectId: "project-b" });
    const snapshot = getVerificationQueueSnapshot();
    expect(snapshot.active).toHaveLength(3);
    expect(new Set(snapshot.active.map((r) => r.attemptId)).size).toBe(3);
    expect(getVerificationQueueSnapshot("project-a").active).toHaveLength(2);
    expect(getVerificationQueueSnapshot("project-b").active).toHaveLength(1);
    expect(snapshot).toMatchObject({ activeCount: 1, waitingCount: 2, countScope: "process" });
    snapshot.active[0]!.state = "settled";
    expect(getVerificationQueueSnapshot().active[0]!.state).toBe("running");
    release();
    await Promise.all([first, second, third]);
    expect(getVerificationQueueSnapshot().settled).toHaveLength(3);
  });

  it("preserves a command rejection and frees the slot", async () => {
    const failure = new Error("fixture command failure");
    await expect(withVerificationSlot(async () => { throw failure; }, {
      taskId: "FN-FAIL", ownerKind: "executor",
    })).rejects.toBe(failure);
    expect(getVerificationQueueSnapshot().settled.at(-1)?.outcome).toBe("failed");
    await expect(withVerificationSlot(async () => "next")).resolves.toBe("next");
  });

  it("bounds history and resets observation without reviving persisted attempts", async () => {
    for (let index = 0; index < 40; index++) {
      await withVerificationSlot(async () => false, { taskId: "FN-HISTORY", ownerKind: "executor" });
    }
    expect(getVerificationQueueSnapshot().settled).toHaveLength(32);
    const old = getVerificationQueueSnapshot();
    resetVerificationLimitRegistryForTests();
    expect(getVerificationQueueSnapshot()).toMatchObject({ active: [], settled: [], activeCount: 0, waitingCount: 0 });
    expect(old.settled).toHaveLength(32);
  });

  it.each([0, -1, 0.5, Infinity, NaN, 300_001])("rejects an invalid queue deadline %s before admission", async (queueTimeoutMs) => {
    const fn = vi.fn(async () => "must not run");
    await expect(withVerificationSlot(fn, { taskId: "FN-BOUND", ownerKind: "executor", queueTimeoutMs })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
