import { describe, expect, it, vi } from "vitest";
import { createExecutorColumnBoundaryHooks } from "../workflow-column-boundary-hooks.js";

function makeStore(taskPatch: Record<string, unknown> = {}, settingsPatch: Record<string, unknown> = {}) {
  return {
    getTask: vi.fn().mockResolvedValue({ id: "FN-PAUSE", paused: false, userPaused: false, ...taskPatch }),
    getSettings: vi.fn().mockResolvedValue({ globalPause: false, enginePaused: false, ...settingsPatch }),
  };
}

describe("executor workflow column-boundary pause probe", () => {
  it.each([
    ["global pause", {}, { globalPause: true }],
    ["engine pause", {}, { enginePaused: true }],
    ["task pause", { paused: true }, {}],
    ["operator pause", { userPaused: true }, {}],
  ])("blocks every node entry for %s", async (_label, taskPatch, settingsPatch) => {
    const store = makeStore(taskPatch, settingsPatch);
    const hooks = createExecutorColumnBoundaryHooks({
      store: store as never,
      task: { id: "FN-PAUSE" },
    });

    await expect(hooks.isPaused?.()).resolves.toBe(true);
  });

  it.each(["task", "settings"])("fails closed when the %s pause authority cannot be read", async (source) => {
    const store = makeStore();
    if (source === "task") store.getTask.mockRejectedValue(new Error("task read failed"));
    else store.getSettings.mockRejectedValue(new Error("settings read failed"));
    const hooks = createExecutorColumnBoundaryHooks({
      store: store as never,
      task: { id: "FN-PAUSE" },
    });

    await expect(hooks.isPaused?.()).resolves.toBe(true);
  });

  it("permits node entry only when both task and project are authoritatively unpaused", async () => {
    const store = makeStore();
    const hooks = createExecutorColumnBoundaryHooks({
      store: store as never,
      task: { id: "FN-PAUSE" },
    });

    await expect(hooks.isPaused?.()).resolves.toBe(false);
  });

  it.each(["task", "settings"])("fails closed when the %s authority is absent", async (source) => {
    const store = makeStore();
    if (source === "task") store.getTask.mockResolvedValue(undefined);
    else store.getSettings.mockResolvedValue(undefined);
    const hooks = createExecutorColumnBoundaryHooks({ store: store as never, task: { id: "FN-PAUSE" } });
    await expect(hooks.isPaused?.()).resolves.toBe(true);
  });
});
