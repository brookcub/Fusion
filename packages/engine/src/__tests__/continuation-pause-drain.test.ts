import { describe, expect, it, vi } from "vitest";
import { InProcessRuntime } from "../runtimes/in-process-runtime.js";

// FNXC:EnginePause 2026-09-05-08:40: the real paused-boot smoke stranded its
// planning continuation for five minutes because pause returned before finally.
describe("continuation drain pause ownership", () => {
  it.each(["enginePaused", "globalPause"])("releases its guard under %s and drains immediately after resume", async (flag) => {
    const runtime = Object.create(InProcessRuntime.prototype) as any;
    runtime.status = "active"; runtime.workflowContinuationDrainActive = false;
    const settings = { [flag]: true };
    const listDue = vi.fn(async () => []);
    runtime.taskStore = { getSettings: vi.fn(async () => settings), listDueWorkflowWorkItems: listDue, getRootDir: () => "fixture" };
    runtime.executor = { execute: vi.fn() };
    await runtime.drainWorkflowContinuations();
    expect(runtime.workflowContinuationDrainActive).toBe(false);
    expect(listDue).not.toHaveBeenCalled();
    settings[flag] = false;
    await runtime.drainWorkflowContinuations();
    expect(listDue).toHaveBeenCalledOnce();
    expect(runtime.workflowContinuationDrainActive).toBe(false);
  });
  it("fails closed on an unreadable pause authority and releases the guard", async () => {
    const runtime = Object.create(InProcessRuntime.prototype) as any;
    runtime.status = "active"; runtime.workflowContinuationDrainActive = false;
    const listDue = vi.fn(async () => []);
    runtime.taskStore = { getSettings: vi.fn(async () => { throw new Error("unavailable"); }), listDueWorkflowWorkItems: listDue, getRootDir: () => "fixture" };
    runtime.executor = { execute: vi.fn() };
    await runtime.drainWorkflowContinuations();
    expect(listDue).not.toHaveBeenCalled();
    expect(runtime.workflowContinuationDrainActive).toBe(false);
  });
});
