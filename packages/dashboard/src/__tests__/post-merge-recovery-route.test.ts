import { describe, expect, it, vi } from "vitest";
import express from "express";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function fixture(outcome = "started", refuse = false, available = true) {
  const retryPostMerge = vi.fn(async () => {
    if (refuse) throw new Error("private refusal detail must not escape");
    return { outcome };
  });
  const logger = { warn() {}, error() {} };
  const router = express.Router();
  registerTaskWorkflowRoutes({ router, store: {}, options: {}, runtimeLogger: logger,
    planningLogger: logger, chatLogger: logger,
    getProjectIdFromRequest: () => "isolated-project",
    getScopedStore: async () => ({}),
    getProjectContext: async () => ({ store: {}, projectId: "isolated-project",
      engine: available ? { getRuntime: () => ({ getExecutor: () => ({ retryPostMerge }) }) } : undefined }),
    prioritizeProjectsForCurrentDirectory: (projects: unknown) => projects,
    emitRemoteRouteDiagnostic() {}, emitAuthSyncAuditLog() {}, parseScopeParam() {},
    resolveAutomationStore: () => ({}), resolveRoutineStore: () => ({}), resolveRoutineRunner: () => ({}),
    registerDispose() {}, dispose() {}, rethrowAsApiError: (e: unknown) => { throw e; },
  } as never, { runtimeLogger: logger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100, validateOptionalModelField: () => undefined,
    normalizeModelSelectionPair: () => ({ provider: null, modelId: null }), runGitCommand: async () => "",
    isGitRepo: async () => true, resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task: unknown) => task, triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  } as never);
  const app = express(); app.use(express.json()); app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    sendErrorResponse(res, error instanceof ApiError ? error.statusCode : 500,
      error instanceof Error ? error.message : "Internal server error");
  });
  const post = (body: unknown) => request(app, "POST", "/api/tasks/RECOVERY-1/retry-post-merge", JSON.stringify(body), { "content-type": "application/json" });
  return { retryPostMerge, post };
}

describe("mounted post-merge recovery HTTP contract", () => {
  it("dispatches through the scoped executor with an exact commit, without restarting implementation", async () => {
    const f = fixture(); const sha = "a".repeat(40); const response = await f.post({ expectedCommitSha: sha });
    expect(response.status).toBe(202); expect(response.body).toEqual({ outcome: "started" });
    expect(f.retryPostMerge).toHaveBeenCalledExactlyOnceWith("RECOVERY-1", sha);
  });
  it.each([{}, { expectedCommitSha: "main" }, { expectedCommitSha: "a".repeat(7) }])("refuses ambiguous identity %j", async body => {
    const f = fixture(); expect((await f.post(body)).status).toBe(400); expect(f.retryPostMerge).not.toHaveBeenCalled();
  });
  it("reports already verified as an idempotent no-op", async () => {
    const f = fixture("already-complete"); expect((await f.post({ expectedCommitSha: "a".repeat(40) })).status).toBe(200);
  });
  it("reports executor refusal without exposing private details", async () => {
    const f = fixture("started", true); const response = await f.post({ expectedCommitSha: "a".repeat(40) });
    expect(response.status).toBe(409); expect(JSON.stringify(response.body)).not.toContain("private refusal");
  });
  it("refuses an unavailable project runtime without dispatch", async () => {
    const f = fixture("started", false, false); expect((await f.post({ expectedCommitSha: "a".repeat(40) })).status).toBe(409);
    expect(f.retryPostMerge).not.toHaveBeenCalled();
  });
});
