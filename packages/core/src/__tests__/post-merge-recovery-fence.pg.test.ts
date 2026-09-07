import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createSharedPgTaskStoreTestHarness, pgDescribe } from "../__test-utils__/pg-test-harness.js";

pgDescribe("post-merge recovery publication selection fence", () => {
  const h = createSharedPgTaskStoreTestHarness({ prefix: "postmerge_recovery_fence", projectId: "isolated-recovery" });
  beforeAll(h.beforeAll); beforeEach(h.beforeEach); afterEach(h.afterEach); afterAll(h.afterAll);
  it("publishes for the exact workflow selection and preserves earlier evidence", async () => {
    const store = h.store(); const task = await store.createTask({ description: "isolated recovery fixture" });
    await store.writeTaskWorkflowSelection(task.id, "builtin:coding", []);
    const result = await store.updateWorkflowStepResultsFenced(task.id, current => ({ workflowStepResults: current.workflowStepResults ?? [] }), "builtin:coding");
    expect(result.applied).toBe(true);
  });
  it("refuses a changed selection before running the publication callback", async () => {
    const store = h.store(); const task = await store.createTask({ description: "isolated recovery fixture" });
    await store.writeTaskWorkflowSelection(task.id, "custom:changed", []);
    let computed = false;
    const result = await store.updateWorkflowStepResultsFenced(task.id, () => { computed = true; return { workflowStepResults: [] }; }, "builtin:coding");
    expect(result).toEqual({ applied: false, reason: "refused" }); expect(computed).toBe(false);
  });
  it("refuses an absent selection rather than falling through to an unfenced write", async () => {
    const store = h.store(); const task = await store.createTask({ description: "isolated recovery fixture" });
    await store.removeMaterializedSelection(task.id);
    let computed = false;
    const result = await store.updateWorkflowStepResultsFenced(task.id, () => { computed = true; return { workflowStepResults: [] }; }, "builtin:coding");
    expect(result).toEqual({ applied: false, reason: "refused" }); expect(computed).toBe(false);
  });
});
