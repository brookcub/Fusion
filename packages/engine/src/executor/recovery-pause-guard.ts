import type { TaskStore } from "@fusion/core";
import { executorLog } from "../logger.js";

/**
 * FNXC:RecoveryPause 2026-09-09-05:12:
 * Late session cleanup can outlive its in-memory abort markers. Recovery must
 * consult durable task and project control before mutating or resuming work.
 * An unavailable authority is a hold, never permission to dispose a checkout.
 */
export async function recoveryIsHeld(
  store: Pick<TaskStore, "getTask" | "getSettings">,
  taskId: string,
): Promise<boolean> {
  try {
    const [task, settings] = await Promise.all([store.getTask(taskId), store.getSettings()]);
    if (!task || !settings) throw new Error("Recovery authority unavailable");
    return Boolean(task.deletedAt || task.paused || task.userPaused || settings.globalPause || settings.enginePaused);
  } catch {
    executorLog.warn(`${taskId}: recovery held because authoritative pause state is unavailable`);
    return true;
  }
}
