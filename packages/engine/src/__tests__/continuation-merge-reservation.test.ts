import { describe, expect, it, vi } from "vitest";
import { ProjectAdmissionCoordinator } from "../concurrency/concurrency.js";

// FNXC:ContinuationMergeHandoff 2026-09-05-13:26: These tests cover accounting
// during cancellation/duplicate handoffs, independently of timers and providers.
async function own(coordinator: ProjectAdmissionCoordinator, continuationOwner = true) {
  await coordinator.admitNext({ projectId: "project-a", maxConcurrent: 1,
    claimed: () => 0, claimedTaskIds: () => [], refresh: async () => [{
      projectId: "project-a", taskId: "task-a", lane: "execute", consumesWorktree: false,
      continuationOwner, start: async () => true,
    }],
  });
}

describe("continuation merge reservation borrowing", () => {
  it.each(["decline", "throw"])("does not hand an existing reservation to a duplicate that would %s", async (outcome) => {
    const coordinator = new ProjectAdmissionCoordinator();
    await own(coordinator);
    const start = vi.fn(async () => {
      if (outcome === "throw") throw new Error("duplicate failed");
      return false;
    });
    const reserve = vi.fn();
    await coordinator.admitNext({ projectId: "project-a", maxConcurrent: 2,
      claimed: () => 0, claimedTaskIds: () => [], refresh: async () => [{
        projectId: "project-a", taskId: "task-a", lane: "review", consumesWorktree: false, start, reserve,
      }],
    });
    expect(start).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(coordinator.inspectProjectStateForTests("project-a").reservedCount).toBe(1);
    const release = coordinator.borrowContinuationMerge("project-a", "task-a");
    expect(release).toBeTypeOf("function");
    release!();
    coordinator.releaseReservation("task-a");
  });

  it("refuses other projects, tasks, and non-continuation reservations", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    await own(coordinator);
    expect(coordinator.borrowContinuationMerge("project-b", "task-a")).toBeUndefined();
    expect(coordinator.borrowContinuationMerge("project-a", "task-b")).toBeUndefined();
    coordinator.releaseReservation("task-a");
    await own(coordinator, false);
    expect(coordinator.borrowContinuationMerge("project-a", "task-a")).toBeUndefined();
  });

  it("allows only one borrower and retains outer ownership after merge failure", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    await own(coordinator);
    const release = coordinator.borrowContinuationMerge("project-a", "task-a");
    expect(release).toBeTypeOf("function");
    expect(coordinator.borrowContinuationMerge("project-a", "task-a")).toBeUndefined();
    await expect((async () => {
      try { throw new Error("merge failed"); } finally { release!(); }
    })()).rejects.toThrow("merge failed");
    release!();
    expect(coordinator.inspectProjectStateForTests("project-a").reservedCount).toBe(1);
    coordinator.releaseReservation("task-a");
    expect(coordinator.inspectProjectStateForTests("project-a").reservedCount).toBe(0);
  });

  it("keeps capacity blocked after outer cancellation until the merger settles", async () => {
    const coordinator = new ProjectAdmissionCoordinator();
    await own(coordinator);
    const release = coordinator.borrowContinuationMerge("project-a", "task-a")!;
    coordinator.releaseReservation("task-a");
    coordinator.releaseReservation("task-a");
    expect(coordinator.borrowContinuationMerge("project-a", "task-a")).toBeUndefined();
    expect(coordinator.inspectProjectStateForTests("project-a").reservedCount).toBe(1);
    const start = vi.fn(async () => true);
    const admit = () => coordinator.admitNext({ projectId: "project-a", maxConcurrent: 1,
      claimed: () => 0, claimedTaskIds: () => [], refresh: async () => [{
        projectId: "project-a", taskId: "task-b", lane: "execute" as const, consumesWorktree: false, start,
      }],
    });
    await admit();
    expect(start).not.toHaveBeenCalled();
    release();
    expect(coordinator.inspectProjectStateForTests("project-a").reservedCount).toBe(0);
    expect(await admit()).toBe("task-b");
    release();
    expect(coordinator.inspectProjectStateForTests("project-a").reservedCount).toBe(1);
  });
});
