import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkflowIr } from "@fusion/core";
import { evaluateTaskReleaseGate, evaluateUnplannedForExecution, isUnplannedForExecution } from "../execution/hold-release.js";

function ir(withReview = true, requirePromptSteps = false): WorkflowIr {
  return {
    version: "v2", name: "gate", columns: [
      { id: "todo", name: "Todo", traits: [{ trait: "hold", config: { release: "capacity" } }] },
      { id: "in-progress", name: "Progress", traits: [{ trait: "wip" }] },
    ],
    nodes: [
      { id: "start", kind: "start", column: "todo" },
      ...(withReview ? [{ id: "plan-review", kind: "optional-group" as const, column: "todo", config: { defaultOn: true, template: { nodes: [], edges: [] } } }] : []),
      ...(requirePromptSteps ? [{ id: "parse", kind: "parse-steps" as const, column: "todo", config: { parser: "step-headings", requireStepsUnlessNoCommits: true } }] : []),
    ],
    edges: [],
  } as WorkflowIr;
}

describe("release-gate verdict", () => {
  let tasksDir: string;

  beforeEach(() => {
    tasksDir = mkdtempSync(join(tmpdir(), "fusion-release-gate-"));
  });

  afterEach(() => {
    rmSync(tasksDir, { recursive: true, force: true });
  });

  function writePrompt(taskId: string, content: string) {
    mkdirSync(join(tasksDir, taskId), { recursive: true });
    writeFileSync(join(tasksDir, taskId, "PROMPT.md"), content, "utf-8");
  }

  function store(overrides: Record<string, unknown> = {}) {
    return { getTasksDir: () => tasksDir, ...overrides } as any;
  }

  it("reports an omitted plan-review node as releasable", async () => {
    const task = { id: "T-1", description: "real", column: "todo", updatedAt: "2026-08-11T00:00:00.000Z" } as any;
    writePrompt(task.id, "# Real spec\n\n## Steps\n### Step 1: Implement\n- [ ] ship it\n");

    const verdict = await evaluateTaskReleaseGate(store(), task, { ir: ir(false) });
    expect(verdict).toMatchObject({ promoteBlocked: false, unplannedForExecution: false, readyAtCapacityBoundary: false, evaluatedForUpdatedAt: task.updatedAt });
    expect(verdict?.planReview).toBeUndefined();
    expect(Number.isFinite(Date.parse(verdict!.evaluatedAt))).toBe(true);
  });

  it("reports a plan-in-place default-on gate and preserves boolean equivalence", async () => {
    const task = { id: "T-2", description: "real", column: "todo" } as any;
    const gateStore = store();
    const result = await evaluateUnplannedForExecution(gateStore, task, ir());
    const verdict = await evaluateTaskReleaseGate(gateStore, task, { ir: ir() });
    expect(result).toMatchObject({ unplanned: true, reason: "plan-review-pending", readyAtCapacityBoundary: false });
    await expect(isUnplannedForExecution(gateStore, task, ir())).resolves.toBe(result.unplanned);
    expect(verdict).toMatchObject({ promoteBlocked: true, reason: "plan-review-pending", blockedOnApproval: false });
  });

  it("treats a capacity continuation as plan-review readiness", async () => {
    const task = { id: "T-3", description: "real", column: "todo" } as any;
    writePrompt(task.id, "# Real spec\n\n## Steps\n### Step 1: Implement\n- [ ] ship it\n");
    const gateStore = store({ listWorkflowWorkItemsForTask: async () => [{ state: "held", waitReason: "capacity", sourceColumn: "todo" }] });
    await expect(evaluateTaskReleaseGate(gateStore, task, { ir: ir() })).resolves.toMatchObject({ promoteBlocked: false, readyAtCapacityBoundary: true });
  });

  it("blocks a stepless prompt when the workflow requires parsed implementation steps", async () => {
    const task = { id: "T-4", title: "Stepless", description: "real", column: "todo" } as any;
    writePrompt(task.id, "# Real spec\n\n## Mission\nDescribe the work without step headings.\n");
    const gateStore = store();

    const result = await evaluateUnplannedForExecution(gateStore, task, ir(false, true));
    const verdict = await evaluateTaskReleaseGate(gateStore, task, { ir: ir(false, true) });

    expect(result).toMatchObject({ unplanned: true, reason: "no-executable-steps" });
    expect(verdict).toMatchObject({ promoteBlocked: true, unplannedForExecution: true, reason: "no-executable-steps" });
    await expect(isUnplannedForExecution(gateStore, task, ir(false, true))).resolves.toBe(true);
  });

  it("allows a parsed step plan when the workflow requires implementation steps", async () => {
    const task = { id: "T-5", title: "Planned", description: "real", column: "todo" } as any;
    writePrompt(task.id, "# Real spec\n\n## Steps\n### Step 1: Implement\n- [ ] ship it\n");

    await expect(evaluateTaskReleaseGate(store(), task, { ir: ir(false, true) })).resolves.toMatchObject({
      promoteBlocked: false,
      unplannedForExecution: false,
      reason: null,
    });
  });

  it("allows a no-commits stepless prompt when the workflow requires implementation steps", async () => {
    const task = { id: "T-6", title: "No commits", description: "real", column: "todo" } as any;
    writePrompt(task.id, "# Real spec\n\n**No commits expected:** true\n");

    await expect(evaluateTaskReleaseGate(store(), task, { ir: ir(false, true) })).resolves.toMatchObject({
      promoteBlocked: false,
      unplannedForExecution: false,
      reason: null,
    });
  });

  it("blocks a missing prompt as no-parsed-plan only when the workflow requires implementation steps", async () => {
    const task = { id: "T-7", title: "Missing prompt", description: "real", column: "todo" } as any;

    await expect(evaluateTaskReleaseGate(store(), task, { ir: ir(false, true) })).resolves.toMatchObject({
      promoteBlocked: true,
      unplannedForExecution: true,
      reason: "no-parsed-plan",
    });
    await expect(evaluateTaskReleaseGate(store(), task, { ir: ir(false, false) })).resolves.toMatchObject({
      promoteBlocked: false,
      unplannedForExecution: false,
      reason: null,
    });
  });
});
