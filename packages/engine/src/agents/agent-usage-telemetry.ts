import type { TaskStore } from "@fusion/core";
import { AgentLogger } from "./agent-logger.js";
import { createLogger } from "../logger.js";

export const AGENT_SESSION_USAGE_CATEGORY = "agent-session";
export type AgentTelemetryLane = "heartbeat" | "executor" | "workflow-step" | "triage" | "reviewer" | "merger";
export type MergerTelemetryRole = "merge-mutation" | "merge-review";
export interface AgentSessionTelemetryContext {
  store: TaskStore;
  agentId?: string | null;
  taskId?: string | null;
  nodeId?: string | null;
  model?: string | null;
  provider?: string | null;
  lane: AgentTelemetryLane;
  /** FNXC:MergeReviewRouting 2026-09-09-23:56: Optional merger sub-role keeps aggregate lane history compatible. */
  role?: MergerTelemetryRole;
  ephemeral?: boolean;
  runId?: string;
}
const log = createLogger("agent-usage-telemetry");
/** Attach telemetry without coupling usage events to the task-log lifecycle. */
export function attachAgentUsageTelemetry(logger: AgentLogger | null | undefined, ctx: AgentSessionTelemetryContext): void {
  if (!logger) return;
  logger.setUsageTelemetry({ store: ctx.store, usageContext: { agentId: ctx.agentId ?? null, nodeId: ctx.nodeId ?? null, model: ctx.model ?? null, provider: ctx.provider ?? null, ...(ctx.role ? { role: ctx.role } : {}) } });
}
/** Emit a single, non-sensitive session boundary event; failures never affect an agent lane. */
export function emitAgentSessionStart(ctx: AgentSessionTelemetryContext): void {
  try {
    const result = ctx.store.emitUsageEvent({ kind: "session_start", taskId: ctx.taskId ?? null, agentId: ctx.agentId ?? null, nodeId: ctx.nodeId ?? null, model: ctx.model ?? null, provider: ctx.provider ?? null, category: AGENT_SESSION_USAGE_CATEGORY, meta: { lane: ctx.lane, ...(ctx.role ? { role: ctx.role } : {}), ...(ctx.ephemeral !== undefined ? { ephemeral: ctx.ephemeral } : {}), ...(ctx.runId ? { runId: ctx.runId } : {}) } });
    void Promise.resolve(result).catch((error) => log.warn(`Failed to emit agent session telemetry: ${error instanceof Error ? error.message : String(error)}`));
  } catch (error) { log.warn(`Failed to emit agent session telemetry: ${error instanceof Error ? error.message : String(error)}`); }
}
