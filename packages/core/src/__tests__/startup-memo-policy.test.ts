import { describe, expect, it, vi } from "vitest";
import { listTasksImpl } from "../task-store/reads.js";
import type { TaskStore } from "../store.js";

function fixture() {
  const listTasks = vi.fn(async (options: { includeDeleted?: boolean }) =>
    options.includeDeleted ? [{ id: "visible" }, { id: "deleted" }] : [{ id: "visible" }]);
  return { store: { isWatching: false, startupSlimListMemo: new Map(), listTasks } as unknown as TaskStore, listTasks };
}

describe("startup task visibility memo", () => {
  it.each([[false, true], [true, false]])("isolates deleted policy %s then %s", async (first, second) => {
    const { store, listTasks } = fixture();
    expect(await listTasksImpl(store, { slim: true, includeDeleted: first })).toHaveLength(first ? 2 : 1);
    expect(await listTasksImpl(store, { slim: true, includeDeleted: second })).toHaveLength(second ? 2 : 1);
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
  it("normalizes omitted and false deleted policy and returns detached values", async () => {
    const { store, listTasks } = fixture();
    const first = await listTasksImpl(store, { slim: true });
    first[0].id = "caller-mutated";
    expect((await listTasksImpl(store, { slim: true, includeDeleted: false }))[0].id).toBe("visible");
    expect(listTasks).toHaveBeenCalledTimes(1);
  });
  it("isolates archive and column filters", async () => {
    const { store, listTasks } = fixture();
    for (const includeArchived of [false, true]) {
      for (const column of [undefined, "todo", "review"]) await listTasksImpl(store, { slim: true, includeArchived, column });
    }
    expect(listTasks).toHaveBeenCalledTimes(6);
  });
  it("keeps comma-containing column names distinct from multiple columns", async () => {
    const { store, listTasks } = fixture();
    await listTasksImpl(store, { slim: true, columns: ["a,b"] });
    await listTasksImpl(store, { slim: true, columns: ["a", "b"] });
    await listTasksImpl(store, { slim: true, excludeColumns: ["a,b"] });
    await listTasksImpl(store, { slim: true, excludeColumns: ["a", "b"] });
    expect(listTasks).toHaveBeenCalledTimes(4);
  });
  it("keeps cursor pages distinct", async () => {
    const { store, listTasks } = fixture();
    await listTasksImpl(store, { slim: true, afterCreatedAt: "2026-01-01", afterId: "A" });
    await listTasksImpl(store, { slim: true, afterCreatedAt: "2026-01-02", afterId: "A" });
    await listTasksImpl(store, { slim: true, afterCreatedAt: "2026-01-02", afterId: "B" });
    expect(listTasks).toHaveBeenCalledTimes(3);
  });
  it("does not share entries between stores", async () => {
    const a = fixture(); const b = fixture();
    await listTasksImpl(a.store, { slim: true });
    await listTasksImpl(b.store, { slim: true });
    expect(a.listTasks).toHaveBeenCalledTimes(1);
    expect(b.listTasks).toHaveBeenCalledTimes(1);
  });
  it("refetches expired cache entries", async () => {
    const { store, listTasks } = fixture();
    await listTasksImpl(store, { slim: true });
    for (const cached of store.startupSlimListMemo.values()) cached.expiresAt = 0;
    await listTasksImpl(store, { slim: true });
    expect(listTasks).toHaveBeenCalledTimes(2);
  });
});
