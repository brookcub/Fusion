import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import type { AsyncDataLayer } from "../../../core/src/postgres/data-layer.js";
import { TaskStore } from "../../../core/src/store.js";
import { TaskDeletedError, TaskNotFoundError } from "../../../core/src/task-store/errors.js";
import { createSharedPgTaskStoreTestHarness, pgDescribe, type SharedPgTaskStoreHarness } from "../../../core/src/__test-utils__/pg-test-harness.js";
import { registerTaskWorkflowRoutes } from "../routes/register-task-workflow-routes.js";
import { request as performRequest } from "../test-request.js";
import { ApiError, sendErrorResponse } from "../api-error.js";

const h: SharedPgTaskStoreHarness = createSharedPgTaskStoreTestHarness({
  prefix: "fusi013_task_log_route",
  projectId: "fusi013-primary-project",
});

function buildApp(store: TaskStore) {
  const runtimeLogger = { warn() {}, error() {} };
  const router = express.Router();
  registerTaskWorkflowRoutes({
    router,
    store,
    options: {},
    runtimeLogger: runtimeLogger as never,
    planningLogger: runtimeLogger as never,
    chatLogger: runtimeLogger as never,
    getProjectIdFromRequest: () => undefined,
    getScopedStore: async () => store,
    getProjectContext: async () => ({ store, engine: undefined, projectId: store.getProjectId() ?? "" }),
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
  } as never, {
    runtimeLogger,
    upload: { single: () => (_req: unknown, _res: unknown, next: () => void) => next() },
    taskDetailActivityLogLimit: 100,
    validateOptionalModelField: (value: unknown) => (typeof value === "string" ? value : undefined),
    normalizeModelSelectionPair: (provider: string | null | undefined, modelId: string | null | undefined) => ({ provider: provider ?? null, modelId: modelId ?? null }),
    runGitCommand: async () => "",
    isGitRepo: async () => true,
    resolveIntegrationBranch: async () => "main",
    trimTaskDetailActivityLog: (task: unknown) => task,
    triggerCommentWakeForAssignedAgent: async () => {},
    resolveSelfHealingManager: () => undefined,
  } as never);
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

async function postLog(app: express.Express, id: string) {
  return performRequest(app, "POST", `/api/tasks/${id}/log`, JSON.stringify({ message: "real route note", level: "info" }), { "content-type": "application/json" });
}

pgDescribe("task activity log route with PostgreSQL TaskStore", () => {
  beforeAll(h.beforeAll);
  afterAll(h.afterAll);
  afterEach(h.afterEach);

  it("returns 404 without mutation for a wholly nonexistent well-formed task id", async () => {
    const store = h.store();
    const before = await store.listTasks();
    const response = await postLog(buildApp(store), "FN-404");

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: "Task FN-404 not found" });
    expect(await store.listTasks()).toEqual(before);
  });

  it("returns 404 without mutating another project that owns the same task id", async () => {
    const otherLayer: AsyncDataLayer = { ...h.layer(), projectId: "fusi013-other-project" };
    const otherStore = new TaskStore(h.rootDir(), undefined, { asyncLayer: otherLayer });
    await otherStore.init();
    try {
      const otherTask = await otherStore.createTask({ description: "other project task" });
      const before = await otherStore.getTask(otherTask.id);
      const response = await postLog(buildApp(h.store()), otherTask.id);

      expect(response.status).toBe(404);
      expect(response.body).toMatchObject({ error: `Task ${otherTask.id} not found` });
      expect(await otherStore.getTask(otherTask.id)).toEqual(before);
    } finally {
      otherStore.stopWatching();
    }
  });

  it("persists an exact successful note without changing unrelated task fields", async () => {
    const store = h.store();
    const task = await store.createTask({ description: "existing task" });
    const before = await store.getTask(task.id);
    const response = await postLog(buildApp(store), task.id);
    const after = await store.getTask(task.id);

    expect(response.status).toBe(200);
    expect(after.log).toHaveLength(before.log.length + 1);
    expect(after.log.at(-1)).toMatchObject({ action: "real route note", outcome: "info" });
    expect({ ...after, log: before.log, updatedAt: before.updatedAt }).toEqual(before);
  });

  it("preserves archived and soft-deleted logging refusals", async () => {
    const store = h.store();
    const archived = await store.createTask({ description: "archived task" });
    await store.archiveTask(archived.id, { cleanup: false });
    const deleted = await store.createTask({ description: "deleted task" });
    await store.deleteTask(deleted.id);
    const app = buildApp(store);

    expect((await postLog(app, archived.id)).status).toBe(500);
    expect((await postLog(app, deleted.id)).status).toBe(500);
  });

  it("keeps an actual PostgreSQL failure as HTTP 500", async () => {
    const sql = h.adminSql();
    await sql.unsafe("ALTER TABLE project.tasks RENAME TO tasks_fusi013_failure");
    try {
      expect((await postLog(buildApp(h.store()), "FN-404")).status).toBe(500);
    } finally {
      await sql.unsafe("ALTER TABLE project.tasks_fusi013_failure RENAME TO tasks");
    }
  });

  it("classifies missing runContext writes as TaskNotFoundError", async () => {
    await expect(h.store().logEntry("FN-404", "run note", undefined, { runId: "run-fusi013", agentId: "agent-fusi013" }))
      .rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it("retains the deleted-store error type outside the route mapping", async () => {
    const task = await h.store().createTask({ description: "deleted direct path" });
    await h.store().deleteTask(task.id);
    await expect(h.store().logEntry(task.id, "note")).rejects.not.toBeInstanceOf(TaskNotFoundError);
    // FNXC:TaskLogRegression 2026-09-06-13:38: Reads intentionally hide deleted
    // tasks as not-found; mutation guards retain the distinct deleted error.
    await expect(h.store().updateTask(task.id, { title: "must not mutate" })).rejects.toBeInstanceOf(TaskDeletedError);
  });
});
