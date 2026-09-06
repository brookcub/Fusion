import { expect, it, vi } from "vitest";
import type { Task } from "@fusion/core";
import { dispatchUnpauseResume } from "../executor/unpause-resume.js";
import { hasRecordedLanding } from "../executor/task-predicates.js";

it.each(["pending", "passed"])("recovers completed implementation with a %s check rather than executing it again", async outcome => {
  const task = { id: "FIXTURE", steps: [{ status: "done" }], mergeDetails: { verificationReceipts: [{ outcome }] } } as Task;
  const deps: any = {
    executing: new Set(), resumingUnpaused: new Set(), recoveringCompleted: new Set(), activeSessions: new Map(),
    activeStepExecutors: new Map(), activeWorkflowStepSessions: new Map(), graphRouting: new Set(), approvalSuspended: new Set(),
    getExecutionPauseLabel: async () => null, recoverCompletedTask: vi.fn(async () => true), execute: vi.fn(),
  };
  expect(await dispatchUnpauseResume(deps, task)).toBe(true);
  expect(deps.recoverCompletedTask).toHaveBeenCalledWith(task);
  expect(deps.execute).not.toHaveBeenCalled();
});
it("retains real and confirmed no-op landing recognition", () => {
  expect(hasRecordedLanding({ mergeDetails: { commitSha: "a".repeat(40) } })).toBe(true);
  expect(hasRecordedLanding({ mergeDetails: { mergeConfirmed: true, noOpMerge: true } })).toBe(true);
});
