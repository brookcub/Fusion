import { expect, it } from "vitest";
import type { TaskStore } from "@fusion/core";
import { verifyAiMergeCandidate } from "../merge/merger-ai-verification.js";

it.each(["paused", "settings", "branch", "review"])("refuses %s changed during the final Git probe", async (change) => {
  const settings: Record<string, unknown> = {};
  const task: Record<string, unknown> = { id: "FIXTURE", branch: "fusion/fixture", column: "in-review" };
  const store = { getTask: async () => task, getSettings: async () => settings,
    updateTaskAtomic: async (_id, updater) => { Object.assign(task, await updater(task)); return task; },
  } as unknown as TaskStore;
  let armed = false;
  const readGit = async (_cwd: string, args: string[]) => {
    if (args[0] === "status") {
      if (armed) {
        if (change === "paused") settings.enginePaused = true;
        if (change === "settings") settings.testCommand = "node new-check.js";
        if (change === "branch") task.branch = "fusion/replacement";
        if (change === "review") task.column = "in-progress";
      }
      return "";
    }
    return args.includes("HEAD") ? "candidate" : "source";
  };
  const assertVerified = await verifyAiMergeCandidate({ store, taskId: "FIXTURE", mergeRoot: "nonexistent-fixture-no-inference",
    branch: "fusion/fixture", tipSha: "base", squashSha: "candidate", log: async () => undefined }, readGit);
  armed = true;
  await expect(assertVerified()).rejects.toThrow();
});
