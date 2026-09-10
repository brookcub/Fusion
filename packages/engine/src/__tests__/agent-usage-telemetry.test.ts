import { describe, expect, it, vi } from "vitest";
import type { TaskStore } from "@fusion/core";
import { AgentLogger } from "../agents/agent-logger.js";
import { AGENT_SESSION_USAGE_CATEGORY, attachAgentUsageTelemetry, emitAgentSessionStart } from "../agents/agent-usage-telemetry.js";

/**
 * FNXC:CommandCenterActivity 2026-08-09-11:12:
 * Durable lanes attach telemetry after resolving their model, so this seam must update identity
 * without making tool callbacks or session boundaries depend on telemetry persistence.
 */
describe("agent usage telemetry", () => {
  it("attaches and refreshes tool identity without requiring a task log", async () => {
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const logger = new AgentLogger({ appendLog: vi.fn().mockResolvedValue(undefined) });
    const store = { emitUsageEvent } as unknown as TaskStore;
    attachAgentUsageTelemetry(logger, { store, agentId: "durable-agent", taskId: null, nodeId: "node-1", model: "first", provider: "provider-a", lane: "heartbeat" });
    logger.onToolStart("Bash", { command: "secret command" });
    attachAgentUsageTelemetry(logger, { store, agentId: "durable-agent", taskId: null, nodeId: "node-1", model: "resolved", provider: "provider-b", lane: "heartbeat" });
    logger.onToolEnd("Bash", false, "secret result");
    await Promise.resolve();

    expect(emitUsageEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ kind: "tool_call", taskId: null, agentId: "durable-agent", nodeId: "node-1", model: "first", provider: "provider-a" }));
    expect(emitUsageEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ kind: "tool_result", taskId: null, agentId: "durable-agent", model: "resolved", provider: "provider-b" }));
  });

  it("emits content-free agent session boundaries fail-soft", async () => {
    const emitUsageEvent = vi.fn().mockRejectedValue(new Error("offline"));
    const store = { emitUsageEvent } as unknown as TaskStore;
    expect(() => emitAgentSessionStart({ store, agentId: "reviewer", taskId: "FN-8868", nodeId: null, model: "validator", provider: "test", lane: "reviewer", ephemeral: false, runId: "run-1" })).not.toThrow();
    expect(emitUsageEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: "session_start", category: AGENT_SESSION_USAGE_CATEGORY, meta: { lane: "reviewer", ephemeral: false, runId: "run-1" } }));
    expect(() => attachAgentUsageTelemetry(null, { store, lane: "reviewer" })).not.toThrow();
  });

  /*
  FNXC:MergerTelemetryRole 2026-09-10-00:19:
  Merge mutation and merge review share the historical merger lane, but operators need the authoritative sub-role on both session and tool usage rows.
  A caller without that new sub-role must retain the exact legacy metadata shape.
  */
  it.each(["merge-mutation", "merge-review"] as const)("emits %s on its merger session and tool rows", (role) => {
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const store = { emitUsageEvent } as unknown as TaskStore;
    const logger = new AgentLogger({ taskId: "FN-MERGE-ROLE", appendLog: vi.fn().mockResolvedValue(undefined) });
    const context = { store, lane: "merger" as const, role, agentId: "merger", taskId: "FN-MERGE-ROLE", nodeId: "merge-node", model: "merge-model", provider: "merge-provider" };

    attachAgentUsageTelemetry(logger, context);
    emitAgentSessionStart(context);
    logger.onToolStart("Read", { path: "private-diff" });
    logger.onToolEnd("Read", false, "private-result");

    const events = emitUsageEvent.mock.calls.map(([event]) => event);
    expect(events.find((event) => event.kind === "session_start")).toMatchObject({ meta: { lane: "merger", role } });
    expect(events.find((event) => event.kind === "tool_call")).toMatchObject({ meta: { role } });
    expect(events.find((event) => event.kind === "tool_result")).toMatchObject({ meta: { role } });
  });

  it("preserves no-role merger usage metadata exactly as before", () => {
    const emitUsageEvent = vi.fn().mockResolvedValue(undefined);
    const store = { emitUsageEvent } as unknown as TaskStore;
    const logger = new AgentLogger({ taskId: "FN-MERGE-LEGACY", appendLog: vi.fn().mockResolvedValue(undefined) });
    const context = { store, lane: "merger" as const, agentId: "merger", taskId: "FN-MERGE-LEGACY" };

    attachAgentUsageTelemetry(logger, context);
    emitAgentSessionStart(context);
    logger.onToolStart("Read", { path: "private-path" });

    const [session, tool] = emitUsageEvent.mock.calls.map(([event]) => event);
    expect(session.meta).toEqual({ lane: "merger" });
    expect(tool).not.toHaveProperty("meta");
  });
});
