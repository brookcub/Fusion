import { describe, expect, it, vi } from "vitest";
import { runImplementationPhase } from "../executor/run-implementation-phase.js";
import { createTaskDoneTool } from "../executor/create-task-done-tool.js";

const task = {
  id: "FUSI-017-SYNTHETIC",
  title: "Synthetic continuation handoff",
  description: "Deterministic continuation fixture",
  column: "in-progress",
  dependencies: [],
  steps: [
    { name: "Completed effect", status: "done" },
    { name: "Current pending requirement", status: "in-progress" },
    { name: "Dependent work", status: "pending" },
  ],
  currentStep: 1,
  log: [],
  prompt: "# Synthetic task",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
} as any;

describe("FUSI-017 continuation completion handoff", () => {
  it("retains the first typed completion payload when a late duplicate callback settles", async () => {
    const result = await runImplementationPhase({
      runImplementation: async (_task: unknown, complete: (info: { modifiedFiles: string[] }) => void) => {
        complete({ modifiedFiles: ["first-effect.ts"] });
        complete({ modifiedFiles: ["stale-replacement-effect.ts"] });
      },
    }, task);

    expect(result).toEqual({ taskDone: true, modifiedFiles: ["first-effect.ts"] });
  });

  it("does not report typed completion when a required step write rejects", async () => {
    const updateStep = vi.fn().mockRejectedValue(new Error("write rejected"));
    const store = {
      getTask: vi.fn().mockResolvedValue(task),
      getSettings: vi.fn().mockResolvedValue({}),
      updateStep,
      updateTask: vi.fn(),
      logEntry: vi.fn(),
    } as any;
    const onDone = vi.fn();
    const tool = createTaskDoneTool({
      store,
      getRunContextFor: () => undefined,
      workflowLifecycleMovesInFlight: new Set(),
      persistTokenUsage: vi.fn(),
      getTaskCompletionBlocker: vi.fn().mockResolvedValue(undefined),
      evaluateTaskVerdictProviders: vi.fn().mockResolvedValue({ ok: true }),
      verifyWorktreeInvariants: vi.fn().mockResolvedValue({ ok: true }),
      evaluateTaskDoneScopeLeak: vi.fn().mockResolvedValue({ blocked: false }),
      scheduleCompletedTaskWatchdog: vi.fn(),
      finalizeAcceptedNoOpCompletion: vi.fn(),
    }, task.id, "/synthetic", "# Synthetic task", new Map([[1, "APPROVE"], [2, "APPROVE"]]), onDone);

    await expect(tool.execute("completion", { summary: "Finished synthetic work" })).rejects.toThrow("write rejected");
    expect(updateStep).toHaveBeenCalledWith(task.id, 1, "done");
    expect(onDone).not.toHaveBeenCalled();
  });
});
