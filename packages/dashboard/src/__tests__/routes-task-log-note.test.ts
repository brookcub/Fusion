// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import express from "express";
import type { Task, TaskStore } from "@fusion/core";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

function mkTask(overrides: Partial<Task> & { id: string }): Task {
  const now = "2026-09-02T14:00:00.000Z";
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    description: overrides.description ?? overrides.id,
    column: overrides.column ?? "todo",
    dependencies: [],
    createdAt: now,
    updatedAt: now,
    size: "S",
    subtasks: [],
    log: [],
    tags: [],
    blockedBy: [],
    source: { sourceType: "api" },
    ...overrides,
  } as Task;
}

function buildApp(store: Partial<TaskStore>) {
  const runtimeLogger = { warn: vi.fn(), error: vi.fn() };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store: store as TaskStore,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store as TaskStore,
    getProjectContext: async () => ({ store: store as TaskStore, engine: undefined, projectId: "p-1" }),
    prioritizeProjectsForCurrentDirectory: (projects) => projects,
    emitRemoteRouteDiagnostic: () => {},
    emitAuthSyncAuditLog: () => {},
    parseScopeParam: () => undefined,
    resolveAutomationStore: () => ({}) as never,
    resolveRoutineStore: () => ({}) as never,
    resolveRoutineRunner: () => ({}) as never,
    registerDispose: () => {},
    dispose: () => {},
    rethrowAsApiError: (error: unknown): never => {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, error instanceof Error ? error.message : "Internal server error");
    },
  }, {
    runtimeLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider, modelId) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  });

  const app = express();
  app.use(express.json());
  app.use("/api", router);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof ApiError) {
      sendErrorResponse(res, error.statusCode, error.message, { details: error.details });
      return;
    }
    sendErrorResponse(res, 500, error instanceof Error ? error.message : "Internal server error");
  });
  return app;
}

describe("POST /api/tasks/:id/log", () => {
  it("appends a task activity log note through TaskStore.logEntry", async () => {
    const task = mkTask({
      id: "FN-024",
      log: [{ timestamp: "2026-09-02T13:59:00.000Z", action: "Existing note", outcome: "info" }],
    });
    const store: Partial<TaskStore> = {
      getTask: vi.fn(async (id: string) => {
        if (id !== task.id) throw Object.assign(new Error(`Task ${id} not found`), { code: "ENOENT" });
        return task;
      }),
      logEntry: vi.fn(async (id: string, message: string, level?: string) => {
        if (id !== task.id) throw Object.assign(new Error(`Task ${id} not found`), { code: "ENOENT" });
        task.log = [...(task.log ?? []), { timestamp: "2026-09-02T14:01:00.000Z", action: message, outcome: level }];
        task.updatedAt = "2026-09-02T14:01:00.000Z";
        return task;
      }),
    };
    const app = buildApp(store);

    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-024/log",
      JSON.stringify({
        message: "Manual operator note",
        level: "info",
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(200);
    expect(store.logEntry).toHaveBeenCalledWith("FN-024", "Manual operator note", "info");
    expect(response.body.log).toEqual([
      { timestamp: "2026-09-02T13:59:00.000Z", action: "Existing note", outcome: "info" },
      { timestamp: "2026-09-02T14:01:00.000Z", action: "Manual operator note", outcome: "info" },
    ]);

    const detailResponse = await performRequest(app, "GET", "/api/tasks/FN-024");
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.body.log).toEqual(response.body.log);
  });

  it.each([
    { name: "missing message", body: { level: "info" }, message: "message is required and must be a string" },
    { name: "empty message", body: { message: "" }, message: "message must be between 1 and 2000 characters" },
    { name: "non-string message", body: { message: 42 }, message: "message is required and must be a string" },
    { name: "non-string level", body: { message: "Manual operator note", level: 42 }, message: "level must be a string" },
  ])("rejects $name without mutating the task log", async ({ body, message }) => {
    const store: Partial<TaskStore> = {
      logEntry: vi.fn(),
      getTask: vi.fn(),
    };
    const app = buildApp(store);

    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-024/log",
      JSON.stringify(body),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: message });
    expect(store.logEntry).not.toHaveBeenCalled();
  });

  it("returns 404 when the task does not exist", async () => {
    const store: Partial<TaskStore> = {
      logEntry: vi.fn(async () => {
        throw Object.assign(new Error("Task FN-404 not found"), { code: "ENOENT" });
      }),
    };
    const app = buildApp(store);

    const response = await performRequest(
      app,
      "POST",
      "/api/tasks/FN-404/log",
      JSON.stringify({
        message: "Manual operator note",
        level: "info",
      }),
      { "content-type": "application/json" },
    );

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: "Task FN-404 not found" });
    expect(store.logEntry).toHaveBeenCalledWith("FN-404", "Manual operator note", "info");
  });
});
