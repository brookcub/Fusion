import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { markStuckAborted } from "../executor/mark-stuck-aborted.js";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "FN-217-STUCK",
    title: "Resume stuck work",
    description: "",
    column: "in-progress",
    status: "failed",
    error: "old session error",
    effectiveNodeId: "steps#0:step-execute",
    currentStep: 1,
    steps: [
      { name: "Implemented", status: "done" },
      { name: "Continue", status: "in-progress" },
    ],
    worktree: "/tmp/fn-217-stuck",
    branch: "fusion/fn-217-stuck",
    dependencies: [],
    log: [],
    createdAt: "2026-08-28T00:00:00.000Z",
    updatedAt: "2026-08-28T00:00:00.000Z",
    ...overrides,
  } as Task;
}

function harness(subject: Task) {
  const reexecuteTaskInPlace = vi.fn(async () => undefined);
  const store = {
    getTask: vi.fn(async () => subject),
    getSettings: vi.fn(async () => ({ globalPause: false, enginePaused: false })),
    updateTask: vi.fn(async (_id: string, patch: Partial<Task>) => Object.assign(subject, patch)),
    logEntry: vi.fn(async () => undefined),
  };
  const deps = {
    store,
    activeStepExecutors: new Map(),
    stuckAborted: new Map<string, boolean>(),
    executing: new Set([subject.id]),
    loopRecoveryState: new Map(),
    terminateAllChildren: vi.fn(async () => undefined),
    awaitAbortInFlightTaskWork: vi.fn(async () => undefined),
    clearPausedAborted: vi.fn(),
    getRunContextFor: vi.fn(() => ({ runId: "owned-run" })),
    reexecuteTaskInPlace,
  };
  return { deps, store, reexecuteTaskInPlace };
}

afterEach(() => vi.useRealTimers());

describe("stuck-session in-place resume", () => {
  it("does not touch a replacement run when an old recovery timer fires", async () => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    markStuckAborted(deps as never, subject.id);
    deps.getRunContextFor.mockReturnValue({ runId: "replacement-run" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(deps.terminateAllChildren).not.toHaveBeenCalled();
  });
  it.each(["globalPause", "enginePaused"] as const)("holds recovery under %s", async (pause) => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    store.getSettings.mockResolvedValue({ globalPause: false, enginePaused: false, [pause]: true });
    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(deps.terminateAllChildren).not.toHaveBeenCalled();
  });

  it.each(["getTask", "getSettings"] as const)("fails closed when %s is unavailable", async (read) => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    store[read].mockRejectedValueOnce(new Error("authority unavailable"));
    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(deps.terminateAllChildren).not.toHaveBeenCalled();
  });

  it("does not redispatch when the predecessor finishes during cleanup", async () => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    deps.awaitAbortInFlightTaskWork.mockImplementationOnce(async () => { deps.executing.delete(subject.id); });
    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
  });

  it.each(["terminateAllChildren", "awaitAbortInFlightTaskWork"] as const)(
    "preserves an operator pause arriving during %s",
    async (boundary) => {
      vi.useFakeTimers();
      const subject = task();
      const { deps, store, reexecuteTaskInPlace } = harness(subject);
      deps[boundary].mockImplementationOnce(async () => {
        Object.assign(subject, { paused: true, userPaused: true, status: "paused" });
      });
      markStuckAborted(deps as never, subject.id);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
      expect(store.updateTask).not.toHaveBeenCalled();
      expect(deps.clearPausedAborted).not.toHaveBeenCalled();
      expect(subject).toMatchObject({
        column: "in-progress", paused: true, userPaused: true, status: "paused",
        worktree: "/tmp/fn-217-stuck", branch: "fusion/fn-217-stuck", currentStep: 1,
        steps: [{ status: "done" }, { status: "in-progress" }],
      });
    },
  );

  it("does not release ownership or resume when child cleanup rejects", async () => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);
    deps.terminateAllChildren.mockRejectedValueOnce(new Error("termination unproven"));
    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(deps.executing.has(subject.id)).toBe(true);
    expect(deps.awaitAbortInFlightTaskWork).not.toHaveBeenCalled();
  });

  it("parks an unsettled predecessor without releasing its ownership or progress", async () => {
    vi.useFakeTimers();
    const subject = task();
    const before = {
      column: subject.column,
      effectiveNodeId: subject.effectiveNodeId,
      currentStep: subject.currentStep,
      steps: structuredClone(subject.steps),
      worktree: subject.worktree,
      branch: subject.branch,
    };
    const { deps, reexecuteTaskInPlace } = harness(subject);

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(subject).toMatchObject({ ...before, status: "failed", paused: true, pausedReason: "stuck-cleanup-incomplete" });
    expect(subject.error).toMatch(/^STUCK_CLEANUP_INCOMPLETE:/);
    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(deps.executing.has(subject.id)).toBe(true);
    expect(deps.clearPausedAborted).not.toHaveBeenCalled();
  });

  it("repeated silence preserves one bounded cleanup-incomplete park", async () => {
    vi.useFakeTimers();
    const subject = task();
    const { deps, store, reexecuteTaskInPlace } = harness(subject);

    for (let round = 0; round < 2; round += 1) {
      deps.executing.add(subject.id);
      markStuckAborted(deps as never, subject.id);
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(subject.status).toBe("failed");
    expect(subject.error).toMatch(/^STUCK_CLEANUP_INCOMPLETE:/);
    expect(subject.paused).toBe(true);
    expect(store.updateTask).toHaveBeenCalledOnce();
    expect(subject).not.toHaveProperty("awaitingApprovalReason");
    expect(JSON.stringify(store.updateTask.mock.calls)).not.toMatch(/STUCK_(?:LOOP_EXHAUSTED|NO_PROGRESS_CHURN)|decompose/i);
  });

  it("leaves a user-paused task under manual control", async () => {
    vi.useFakeTimers();
    const subject = task({ paused: true, userPaused: true, status: "paused" });
    const { deps, store, reexecuteTaskInPlace } = harness(subject);

    markStuckAborted(deps as never, subject.id);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(reexecuteTaskInPlace).not.toHaveBeenCalled();
    expect(store.updateTask).not.toHaveBeenCalled();
    expect(subject).toMatchObject({ column: "in-progress", paused: true, userPaused: true, status: "paused" });
  });
});
