import { expect, it, vi } from "vitest";
import { ProjectEngine } from "../project-engine.js";

it("does not report a retry or consume an attempt when the real lifecycle boundary refuses the move", async () => {
  const engine = Object.create(ProjectEngine.prototype) as any;
  engine.runtime = { getExecutor: () => ({ isTaskLiveForOverseerRetry: () => false }) };
  engine.plannerLiveRetrySkipLogDedup = new Set();
  engine.emitOverseerInterventionSafe = vi.fn(async () => undefined);
  const task = { id: "FUSI-999", column: "in-progress", branch: "fusion/fusi-999" };
  const store = {
    getTask: vi.fn(async () => task),
    logEntry: vi.fn(async () => undefined),
    moveTask: vi.fn(async () => undefined),
  };
  const handlers = engine.buildPlannerRecoveryHandlers(store);
  const dispatched = await handlers.retryStep(task, {
    watchedStage: "executor", reason: "fixture failed", attemptCount: 0, attemptLimit: 3, sourceLinks: [],
  });
  expect(dispatched).toBe(false);
  expect(store.moveTask).not.toHaveBeenCalled();
  expect(engine.emitOverseerInterventionSafe).not.toHaveBeenCalled();
  expect(task).toEqual({ id: "FUSI-999", column: "in-progress", branch: "fusion/fusi-999" });
});
