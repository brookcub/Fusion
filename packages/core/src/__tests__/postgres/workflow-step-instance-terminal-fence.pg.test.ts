import { expect, it } from "vitest";
import {
  pgDescribe,
  createTaskStoreForTest,
  type PgTestHarness,
} from "../../__test-utils__/pg-test-harness.js";

pgDescribe("workflow step-instance terminal-state fencing (PostgreSQL)", () => {
  let harness: PgTestHarness | null = null;

  async function makeHarness(): Promise<PgTestHarness> {
    harness = await createTaskStoreForTest({ prefix: "fusion_foreach_terminal_fence" });
    return harness;
  }

  async function teardown(): Promise<void> {
    if (harness) {
      await harness.teardown();
      harness = null;
    }
  }

  it("does not let a delayed same-run in-progress writer regress a completed instance", async () => {
    const h = await makeHarness();
    try {
      const task = await h.store.createTask({ description: "foreach terminal fence" });
      const base = {
        taskId: task.id,
        runId: "run-same",
        foreachNodeId: "steps",
        stepIndex: 0,
        pinnedStepCount: 1,
      } as const;

      const staleSnapshot = {
        ...base,
        currentNodeId: "step-execute",
        status: "in-progress" as const,
        checkpointId: "checkpoint-before-terminal",
        reworkCount: 0,
      };

      await h.store.saveWorkflowRunStepInstanceAsync(staleSnapshot);
      expect((await h.store.loadWorkflowRunStepInstancesAsync(task.id, base.runId))[0]).toMatchObject({
        status: "in-progress",
        currentNodeId: "step-execute",
      });

      await h.store.saveWorkflowRunStepInstanceAsync({
        ...base,
        currentNodeId: "step-review",
        status: "completed",
        checkpointId: "checkpoint-terminal",
        reworkCount: 1,
      });
      expect((await h.store.loadWorkflowRunStepInstancesAsync(task.id, base.runId))[0]).toMatchObject({
        status: "completed",
        currentNodeId: "step-review",
        checkpointId: "checkpoint-terminal",
        reworkCount: 1,
      });

      // Simulate a writer that began from the same run/instance before the
      // terminal publication but reaches the store after it. Terminal state is
      // graph ownership evidence and must not move backwards.
      await h.store.saveWorkflowRunStepInstanceAsync(staleSnapshot);

      expect((await h.store.loadWorkflowRunStepInstancesAsync(task.id, base.runId))[0]).toMatchObject({
        status: "completed",
        currentNodeId: "step-review",
        checkpointId: "checkpoint-terminal",
        reworkCount: 1,
      });
    } finally {
      await teardown();
    }
  });
});
