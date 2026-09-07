import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { getBuiltinWorkflow, type Task, type WorkflowIr } from "@fusion/core";
import { assertRecoveryCurrent, assertRecoveryIr, planPostMergeRecovery, readPostMergeRecoveryPlan, recoveryTaskIsCurrent, requireRecoveryPublication } from "../executor/post-merge-recovery.js";
import { WorkflowGraphTaskRunner } from "../workflows/workflow-graph-task-runner.js";
import { TaskExecutor } from "../executor.js";
import { persistWorkflowStepResultWithOutcome } from "../executor/execute-workflow-graph.js";

const sha = "a".repeat(40);
const ir = () => structuredClone(getBuiltinWorkflow("builtin:coding")!.ir) as WorkflowIr;
const task = () => ({ id: "RECOVERY-1", column: "done", status: null,
  steps: [{ status: "done" }], enabledWorkflowSteps: ["code-review", "post-merge-verification"],
  mergeDetails: { mergeConfirmed: true, commitSha: sha },
  workflowStepResults: [{ workflowStepId: "code-review", phase: "pre-merge", status: "passed", verdict: "APPROVE" }],
}) as Task;

describe("post-merge-only recovery admission", () => {
  it("selects only the missing verification tail without changing earlier evidence", () => {
    const row = task(); const before = structuredClone(row);
    expect(planPostMergeRecovery(row, ir(), sha)?.entryNodeId).toBe("post-merge-verification");
    expect(row).toEqual(before);
  });
  it("is a no-op for a passed tail", () => {
    const row = task();
    row.workflowStepResults!.push({ workflowStepId: "post-merge-verification", phase: "post-merge", status: "passed" } as never);
    expect(planPostMergeRecovery(row, ir(), sha)).toBeNull();
  });
  it.each([
    { column: "in-review" }, { paused: true }, { userPaused: true }, { deletedAt: "2026-01-01" },
    { mergeDetails: { mergeConfirmed: false, commitSha: sha } },
    { mergeDetails: { mergeConfirmed: true, commitSha: "b".repeat(40) } },
    { steps: [{ status: "pending" }] }, { enabledWorkflowSteps: ["code-review"] },
    { workflowStepResults: [] }, { status: "failed" },
  ])("refuses unsafe state %j", (patch) => {
    expect(() => planPostMergeRecovery({ ...task(), ...patch } as Task, ir(), sha)).toThrow();
  });
  it("rejects nested coding leaves, changed prompts and extra downstream groups", () => {
    for (const change of ["coding", "prompt", "extra"] as const) {
      const graph = ir();
      const group = graph.nodes.find((n) => n.id === "post-merge-verification")!;
      const template = group.config!.template as { nodes: Array<{ config: Record<string, unknown> }> };
      if (change === "coding") template.nodes[0].config.toolMode = "coding";
      if (change === "prompt") template.nodes[0].config.prompt = "write files";
      if (change === "extra") graph.nodes.push({ ...structuredClone(group), id: "second-post-merge" });
      expect(() => planPostMergeRecovery(task(), graph, sha)).toThrow("unchanged built-in");
    }
  });
  it("fences reopen, changed landing, changed enablement and earlier review mutation", () => {
    const row = task(); const plan = planPostMergeRecovery(row, ir(), sha)!;
    expect(recoveryTaskIsCurrent(row, plan)).toBe(true);
    for (const patch of [{ column: "in-review" }, { paused: true }, { enabledWorkflowSteps: [] },
      { mergeDetails: { mergeConfirmed: true, commitSha: "b".repeat(40) } }, { workflowStepResults: [] }]) {
      expect(recoveryTaskIsCurrent({ ...row, ...patch } as Task, plan)).toBe(false);
    }
    row.workflowStepResults!.push({ workflowStepId: "post-merge-verification", phase: "post-merge", status: "pending" } as never);
    expect(recoveryTaskIsCurrent(row, plan)).toBe(true);
  });
});

describe("actual recovery graph runner", () => {
  function fixture(refuseAt?: "pending" | "passed", abort = false, changedSelection = false) {
    const row = task(); const before = structuredClone(row.workflowStepResults);
    const plan = planPostMergeRecovery(row, ir(), sha)!;
    const controller = new AbortController();
    const seam = vi.fn(async () => { throw new Error("Recovery entered implementation/lifecycle seam"); });
    const custom = vi.fn(async () => {
      if (abort) controller.abort();
      return { outcome: "success" as const, value: "APPROVE" };
    });
    const store = {
      getTask: async () => structuredClone(row), updateTask: vi.fn(),
      getTaskWorkflowSelection: () => ({ workflowId: changedSelection ? "custom:changed" : "builtin:coding", stepIds: row.enabledWorkflowSteps! }),
      getWorkflowDefinition: async () => ({ ...getBuiltinWorkflow("builtin:coding")!, id: "custom:changed" }),
      logEntry: vi.fn(async () => {}),
      updateWorkflowStepResultsFenced: vi.fn(async (_id, compute, expectedWorkflowId) => {
        expect(expectedWorkflowId).toBe("builtin:coding");
        const patch = compute(row);
        if (!patch || patch.workflowStepResults?.some((r: { status: string; phase: string }) => r.phase === "post-merge" && r.status === refuseAt))
          return { applied: false, reason: "refused" };
        Object.assign(row, patch);
        return { applied: true, task: structuredClone(row) };
      }),
    };
    const runner = new WorkflowGraphTaskRunner({ store: store as never, requireDurableWorkflowStepResults: true,
      seams: { planning: seam, execute: seam, review: seam, merge: seam, schedule: seam },
      runCustomNode: custom, signal: controller.signal,
      validateResolvedWorkflow: (id, actualIr) => {
        if (id !== "builtin:coding") throw new Error("Recovery workflow changed");
        assertRecoveryIr(actualIr, plan);
      },
      recordWorkflowStepResult: async (id, result, fence) => {
        const outcome = await persistWorkflowStepResultWithOutcome({ store, getRunContextFor: () => undefined } as never,
          id, result, { ...fence, signal: controller.signal, expectedWorkflowId: "builtin:coding", taskGuard: current => recoveryTaskIsCurrent(current, plan) });
        requireRecoveryPublication(outcome);
        return outcome;
      },
    });
    return { row, before, runner, seam, custom };
  }
  it("executes only the read-only tail and preserves prior reviews", async () => {
    const f = fixture(); const result = await f.runner.run(f.row as never, undefined, "post-merge-verification");
    expect(result.disposition).toBe("completed");
    expect(f.custom).toHaveBeenCalledTimes(1); expect(f.seam).not.toHaveBeenCalled();
    expect(f.row.workflowStepResults?.filter(r => r.phase !== "post-merge")).toEqual(f.before);
    expect(f.row.workflowStepResults?.find(r => r.phase === "post-merge")?.status).toBe("passed");
  });
  it.each(["pending", "passed"] as const)("cannot complete after a refused %s write", async refuseAt => {
    const f = fixture(refuseAt); const result = await f.runner.run(f.row as never, undefined, "post-merge-verification");
    expect(result.disposition).toBe("failed");
    expect(f.custom).toHaveBeenCalledTimes(refuseAt === "pending" ? 0 : 1);
    expect(f.seam).not.toHaveBeenCalled();
    expect(f.row.workflowStepResults?.filter(r => r.phase !== "post-merge")).toEqual(f.before);
    expect(f.row.workflowStepResults?.some(r => r.phase === "post-merge" && r.status === "passed")).toBe(false);
  });
  it("cannot publish success after cancellation", async () => {
    const f = fixture(undefined, true); const result = await f.runner.run(f.row as never, undefined, "post-merge-verification");
    expect(result.disposition).not.toBe("completed"); expect(f.seam).not.toHaveBeenCalled();
    expect(f.row.workflowStepResults?.filter(r => r.phase !== "post-merge")).toEqual(f.before);
    expect(f.row.workflowStepResults?.some(r => r.phase === "post-merge" && r.status === "passed")).toBe(false);
  });
  it("refuses the actual changed runner selection before any node side effect", async () => {
    const f = fixture(undefined, false, true); const result = await f.runner.run(f.row as never, undefined, "post-merge-verification");
    expect(result.disposition).toBe("failed"); expect(f.custom).not.toHaveBeenCalled(); expect(f.seam).not.toHaveBeenCalled();
    expect(f.row.workflowStepResults).toEqual(f.before);
  });
});

describe("recovery ownership and atomic result identity", () => {
  function fixture() {
    const row = task();
    const store = Object.assign(new EventEmitter(), {
      getTask: vi.fn(async () => structuredClone(row)),
      getSettings: vi.fn(async () => ({ enginePaused: false, globalPause: false })),
      getTaskWorkflowSelectionAsync: vi.fn(async () => ({ workflowId: "builtin:coding", stepIds: row.enabledWorkflowSteps })),
      listWorkflowWorkItemsForTask: vi.fn(async () => []),
      getRootDir: () => "C:/isolated-recovery-fixture",
      logEntry: vi.fn(async () => {}),
    });
    const executor = new TaskExecutor(store as never, store.getRootDir());
    const invoke = vi.spyOn(executor as unknown as { executeWorkflowGraph: (...args: unknown[]) => Promise<void> }, "executeWorkflowGraph");
    return { row, store, executor, invoke };
  }
  it("claims before admission awaits and runs exactly one graph", async () => {
    const f = fixture();
    let finish!: () => void;
    f.invoke.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = f.executor.retryPostMerge(f.row.id, sha);
    expect(await f.executor.retryPostMerge(f.row.id, sha)).toEqual({ outcome: "already-running" });
    expect(await first).toEqual({ outcome: "started" });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.invoke.mock.calls[0][1]).toMatchObject({ postMergeRecovery: { commitSha: sha, entryNodeId: "post-merge-verification" } });
    finish();
  });
  it("refuses a paused project without dispatch", async () => {
    const f = fixture(); f.store.getSettings.mockResolvedValue({ enginePaused: true, globalPause: false });
    await expect(f.executor.retryPostMerge(f.row.id, sha)).rejects.toThrow("paused");
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("refuses admission when the resolver masks its own failed selection read", async () => {
    const f = fixture();
    f.store.getTaskWorkflowSelectionAsync.mockResolvedValueOnce({ workflowId: "builtin:coding", stepIds: f.row.enabledWorkflowSteps })
      .mockRejectedValueOnce(new Error("selection read unavailable"));
    await expect(readPostMergeRecoveryPlan(f.store as never, f.row.id, sha)).rejects.toThrow("authority is unavailable");
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("refuses publication authority when only the parallel selection read succeeds", async () => {
    const f = fixture(); const plan = planPostMergeRecovery(f.row, ir(), sha)!;
    f.store.getTaskWorkflowSelectionAsync.mockRejectedValueOnce(new Error("resolver selection read unavailable"));
    await expect(assertRecoveryCurrent(f.store as never, plan)).rejects.toThrow("authority is unavailable");
    expect(f.store.getTaskWorkflowSelectionAsync).toHaveBeenCalledTimes(2);
  });
  it("does not publish a success after the landed identity changes at the atomic writer", async () => {
    const row = task(); const plan = planPostMergeRecovery(row, ir(), sha)!;
    const before = structuredClone(row.workflowStepResults);
    const store = {
      getTask: async () => structuredClone(row), updateTask: vi.fn(),
      updateWorkflowStepResultsFenced: vi.fn(async (_id, compute) => {
        row.mergeDetails!.commitSha = "b".repeat(40);
        const patch = compute(row);
        expect(patch).toBeNull();
        return { applied: false, reason: "refused" };
      }),
    };
    const result = await persistWorkflowStepResultWithOutcome({ store, getRunContextFor: () => undefined } as never,
      row.id, { workflowStepId: "post-merge-verification", phase: "post-merge", status: "passed" } as never,
      { taskGuard: (current) => recoveryTaskIsCurrent(current, plan) });
    expect(result.persisted).toBe(false);
    expect(row.workflowStepResults).toEqual(before);
    expect(store.updateTask).not.toHaveBeenCalled();
  });
});
