// @vitest-environment node
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { getVerificationQueueSnapshot, withVerificationSlot } from "../../../../engine/src/concurrency/verification-concurrency.js";
import { registerProjectRoutes } from "../register-project-routes.js";
import { request } from "../../test-request.js";

vi.mock("../../project-store-resolver.js", () => ({
  getOrCreateProjectStore: vi.fn(async () => ({ listTasks: async () => [] })),
  evictProjectStore: vi.fn(),
}));

function appFor(engineAvailable: boolean) {
  const router = express.Router();
  registerProjectRoutes({
    router,
    options: {
      centralCore: {
        isInitialized: () => true,
        getProject: async (id: string) => ({ id }),
        getProjectHealth: async () => ({ verificationQueue: { stale: true } }),
      },
      engineManager: { getEngine: (id: string) => engineAvailable ? {
        getVerificationQueueSnapshot: () => getVerificationQueueSnapshot(id),
      } : undefined },
    },
    runtimeLogger: { child: () => ({ warn: vi.fn() }), warn: vi.fn() },
    prioritizeProjectsForCurrentDirectory: vi.fn((projects) => projects),
    rethrowAsApiError: (error: unknown) => { throw error; },
  } as never);
  const app = express();
  app.use("/api", router);
  return app;
}

describe("project verification queue health", () => {
  it("returns live project owners and process-wide counts, then no active owner after settlement", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holder = withVerificationSlot(async () => gate, {
      taskId: "FN-HOLDER", projectId: "project-b", ownerKind: "executor",
    });
    await Promise.resolve();
    const waiter = withVerificationSlot(async () => "done", {
      taskId: "FN-WAITER", projectId: "project-a", ownerKind: "merger",
    });
    try {
      const response = await request(appFor(true), "GET", "/api/projects/project-a/health");
      expect(response.status).toBe(200);
      const queue = (response.body as { verificationQueue: ReturnType<typeof getVerificationQueueSnapshot> }).verificationQueue;
      expect(queue).toMatchObject({ countScope: "process", activeCount: 1, waitingCount: 1 });
      expect(queue.active).toHaveLength(1);
      expect(queue.active[0]).toMatchObject({ projectId: "project-a", taskId: "FN-WAITER", state: "queued" });
      expect(JSON.stringify(queue)).not.toContain("FN-HOLDER");
    } finally {
      release();
      await Promise.all([holder, waiter]);
    }
    const response = await request(appFor(true), "GET", "/api/projects/project-a/health");
    expect(response.body).toMatchObject({ verificationQueue: { active: [], activeCount: 0, waitingCount: 0 } });
  });

  it("returns unknown when no engine exists, overriding stale persisted metadata", async () => {
    const response = await request(appFor(false), "GET", "/api/projects/project-a/health");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ verificationQueue: null });
  });
});
