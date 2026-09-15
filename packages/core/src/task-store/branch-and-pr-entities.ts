/**
 * FNXC:CodeOrganization 2026-07-19-12:00:
 * Domain rename from branch-and-pr-entities: branch groups, PR entities, and PR thread state.
 *
 * FNXC:StoreModularization 2026-06-25-00:00:
 * Extracted from the monolithic packages/core/src/store.ts as a pure
 * behavior-preserving refactor. Each function receives the TaskStore
 * instance as its first parameter and performs byte-identical work.
 */

import { TaskStore } from "../store.js";
import { filterTasksByBranchGroup } from "../branch/branch-assignment.js";
import { BUILTIN_WORKFLOW_SETTINGS } from "../workflows/builtin-workflow-settings.js";
import { isBuiltinWorkflowId } from "../workflows/builtin-workflows.js";
import { FINGERPRINT_WINDOW_DEFAULT_MS, FINGERPRINT_WINDOW_MAX_MS } from "../duplicates/duplicate-guard.js";
import * as schema from "../postgres/schema/index.js";
import { taskProjectScope } from "../postgres/data-layer.js";
import { ensureBranchGroupForSource as ensureBranchGroupForSourceAsync, ensurePrEntityForSource as ensurePrEntityForSourceAsync, getActivePrEntityBySource as getActivePrEntityBySourceAsync, getBranchGroup as getBranchGroupAsync, getBranchGroupByBranchName as getBranchGroupByBranchNameAsync, getBranchGroupBySource as getBranchGroupBySourceAsync, getPrEntity as getPrEntityAsync, getPrThreadState as getPrThreadStateAsync, listActivePrEntities as listActivePrEntitiesAsync, listBranchGroups as listBranchGroupsAsync, listPrThreadStates as listPrThreadStatesAsync, recordPrThreadOutcome as recordPrThreadOutcomeAsync } from "./async/async-branch-groups.js";
import { getWorkflowWorkItem as getWorkflowWorkItemAsync } from "./async/async-workflow-workitems.js";
import { MergeRequestRow, PrEntityRow, WorkflowWorkItemRow } from "./row-types.js";
import { BranchGroup, BranchGroupCreateInput, ColumnId, MergeRequestRecord, MergeRequestState, PrEntity, PrEntityCreateInput, PrThreadOutcome, PrThreadState, RunMutationContext, Task, TaskLogEntry, TaskPriority, TaskVerificationRequest, TaskVerificationResultSummary, TaskVerificationStatus, WorkflowWorkItem, WorkflowWorkItemKind, WorkflowWorkItemState, WorkflowWorkItemTransitionPatch } from "../types.js";
import { validateNodeOverrideChange, resolveNodeOverrideLanes} from "../mesh/node-override-guard.js";
import { WorkflowMovePolicyInput } from "../workflows/workflow-extension-types.js";
import { resolveWorkflowIrById, isTaskTerminalNodeIdAsync} from "../workflows/workflow-ir-resolver.js";
import { WorkflowSettingDefinition } from "../workflows/workflow-ir-types.js";
import { resolveTaskLifecycleColumns } from "../workflows/workflow-lifecycle-traits.js";
import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { MoveTaskInternalOptions, MoveTaskOptions, storeLog } from "../store.js";
import { ARCHIVED_SENTINEL_LANES, resolveProjectColumnsForRoles } from "../project-lane-vocabulary.js";
import {writePromptFileAtomic} from "./prompt-file.js";

/*
FNXC:BranchGroupProjectIsolation 2026-08-12-14:30:
TaskStore is the production branch-group boundary, so every wrapper must forward its bound project id to the optional helper predicate. Omitting it makes owner-connected PostgreSQL reads and mutations cross project partitions despite scoped helper implementations.
*/
export async function getBranchGroupImpl(store: TaskStore, id: string): Promise<BranchGroup | null> {
    // FNXC:RuntimeWorkflowAsync 2026-06-24-16:21:
        const layer = store.asyncLayer!;
    return getBranchGroupAsync(layer.db, id, layer.projectId);
}

export async function getBranchGroupBySourceImpl(store: TaskStore, sourceType: BranchGroup["sourceType"], sourceId: string): Promise<BranchGroup | null> {
        const layer = store.asyncLayer!;
    return getBranchGroupBySourceAsync(layer.db, sourceType, sourceId, layer.projectId);
}

export async function getBranchGroupByBranchNameImpl(store: TaskStore, branchName: string): Promise<BranchGroup | null> {
        const layer = store.asyncLayer!;
    return getBranchGroupByBranchNameAsync(layer.db, branchName, layer.projectId);
}

export async function ensureBranchGroupForSourceImpl(store: TaskStore,
    sourceType: BranchGroup["sourceType"],
    sourceId: string,
    init: Omit<BranchGroupCreateInput, "sourceType" | "sourceId">,
  ): Promise<BranchGroup> {
    /*
    FNXC:SqliteDualPathCleanup 2026-07-26-14:07:
    Branch-group ensure is PostgreSQL-only via ensureBranchGroupForSourceAsync (UNIQUE branchName reuse lives in the async helper).
    */
    const layer = store.asyncLayer!;
    return ensureBranchGroupForSourceAsync(layer.db, sourceType, sourceId, init, layer.projectId);
}

export async function listBranchGroupsImpl(store: TaskStore, options?: { status?: BranchGroup["status"] }): Promise<BranchGroup[]> {
        const layer = store.asyncLayer!;
    return listBranchGroupsAsync(layer.db, options, layer.projectId);
}

/*
FNXC:BranchGroupCompletion 2026-07-18-01:55:
Archived shared-branch members remain part of promotion completion: an unlanded archived
member blocks promotion, while an archived member with persisted landing proof permits it.
The PostgreSQL path must therefore load archived tasks before applying group membership.
*/
export async function listTasksByBranchGroupImpl(store: TaskStore, groupId: string): Promise<Task[]> {
    const tasks = await store.listTasks({ includeArchived: false, slim: false });
    // Membership filter (incl. legacy synthetic-groupId fallback) is shared with
    // the dashboard list route via `filterTasksByBranchGroup` so semantics can't
    // drift between the two call sites (Fix #8/#9).
    const group = await store.getBranchGroup(groupId);
    return filterTasksByBranchGroup(tasks, group, groupId).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
}

export async function getPrEntityImpl(store: TaskStore, id: string): Promise<PrEntity | null> {
        const layer = store.asyncLayer!;
    return getPrEntityAsync(layer.db, id);
}

export async function getActivePrEntityBySourceImpl(store: TaskStore, sourceType: PrEntity["sourceType"], sourceId: string): Promise<PrEntity | null> {
        const layer = store.asyncLayer!;
    return getActivePrEntityBySourceAsync(layer.db, sourceType, sourceId);
}

export async function getPrEntityByNumberImpl(store: TaskStore, repo: string, prNumber: number): Promise<PrEntity | null> {
    // No dedicated async helper for by-number lookup; use the sync path's SQL
    // shape via a raw Drizzle query in backend mode.
        const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.pullRequests)
      .where(and(eq(schema.project.pullRequests.repo, repo), eq(schema.project.pullRequests.prNumber, prNumber)))
      .limit(1);
    const row = rows[0] as PrEntityRow | undefined;
    return row ? store.rowToPrEntity(row) : null;
}

export async function ensurePrEntityForSourceImpl(store: TaskStore, input: PrEntityCreateInput): Promise<PrEntity> {
        const layer = store.asyncLayer!;
    return ensurePrEntityForSourceAsync(layer.db, input);
}

export async function listActivePrEntitiesImpl(store: TaskStore): Promise<PrEntity[]> {
        const layer = store.asyncLayer!;
    return listActivePrEntitiesAsync(layer.db);
}

export async function getPrThreadStateImpl(store: TaskStore, repo: string, prNumber: number): Promise<PrThreadState | null> {
        const layer = store.asyncLayer!;
    return getPrThreadStateAsync(layer.db, repo, prNumber);
}

export async function listPrThreadStatesImpl(store: TaskStore, repo?: string): Promise<PrThreadState[]> {
        const layer = store.asyncLayer!;
    return listPrThreadStatesAsync(layer.db, repo);
}

export async function recordPrThreadOutcomeImpl(store: TaskStore, repo: string, prNumber: number, outcome: PrThreadOutcome): Promise<void> {
        const layer = store.asyncLayer!;
    await recordPrThreadOutcomeAsync(layer.db, repo, prNumber, outcome);
}

export async function listMergeRequestsImpl(store: TaskStore): Promise<MergeRequestRecord[]> {
        const layer = store.asyncLayer!;
    const rows = await layer.db.select().from(schema.project.mergeRequests)
      .where(eq(schema.project.mergeRequests.projectId, layer.projectId))
      .orderBy(asc(schema.project.mergeRequests.createdAt));
    return rows.map((row) => ({
      id: row.id,
      taskId: row.taskId,
      state: row.state as MergeRequestState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
}

export async function createMergeRequestImpl(store: TaskStore, taskId: string): Promise<MergeRequestRecord> {
        const layer = store.asyncLayer!;
    const now = new Date().toISOString();
    const rows = await layer.db
      .insert(schema.project.mergeRequests)
      .values({
        projectId: layer.projectId,
        taskId,
        state: "queued",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const row = rows[0];
    if (!row) throw new Error("Failed to create merge request");
    return {
      id: row.id,
      taskId: row.taskId,
      state: row.state as MergeRequestState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
}

export async function updateMergeRequestStateImpl(store: TaskStore, id: string, state: MergeRequestState): Promise<void> {
        const layer = store.asyncLayer!;
    await layer.db
      .update(schema.project.mergeRequests)
      .set({ state, updatedAt: new Date().toISOString() })
      .where(and(
        eq(schema.project.mergeRequests.projectId, layer.projectId),
        eq(schema.project.mergeRequests.id, id),
      ));
}

export async function getWorkflowWorkItemImpl(store: TaskStore, taskId: string): Promise<WorkflowWorkItem | null> {
        const layer = store.asyncLayer!;
    return getWorkflowWorkItemAsync(layer.db, taskId, layer.projectId);
}

export async function listWorkflowWorkItemsImpl(store: TaskStore, state?: WorkflowWorkItemState): Promise<WorkflowWorkItem[]> {
        const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.projectId, layer.projectId),
        ...(state ? [eq(schema.project.workflowWorkItems.state, state)] : []),
      ))
      .orderBy(asc(schema.project.workflowWorkItems.updatedAt));
    return rows.map((row) => store.rowToWorkflowWorkItem(row as WorkflowWorkItemRow));
}

export async function getWorkflowRunBranchImpl(store: TaskStore, taskId: string, runId: string, branchId: string): Promise<import("../types.js").WorkflowRunBranchState | null> {
    const layer = store.asyncLayer!;
    const rows = await layer.db
      .select()
      .from(schema.project.workflowRunBranches)
      .where(and(
        eq(schema.project.workflowRunBranches.projectId, layer.projectId),
        eq(schema.project.workflowRunBranches.taskId, taskId),
        eq(schema.project.workflowRunBranches.runId, runId),
        eq(schema.project.workflowRunBranches.branchId, branchId),
      ))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      taskId: row.taskId,
      runId: row.runId,
      branchId: row.branchId,
      currentNodeId: row.currentNodeId,
      status: row.status as import("../types.js").WorkflowRunBranchState["status"],
      updatedAt: row.updatedAt,
    };
}

export async function saveWorkflowRunBranchImpl(store: TaskStore, state: import("../types.js").WorkflowRunBranchState): Promise<void> {
    const layer = store.asyncLayer!;
    const now = new Date().toISOString();
    await layer.db
      .insert(schema.project.workflowRunBranches)
      .values({
        taskId: state.taskId,
        runId: state.runId,
        branchId: state.branchId,
        currentNodeId: state.currentNodeId,
        status: state.status,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          schema.project.workflowRunBranches.projectId,
          schema.project.workflowRunBranches.taskId,
          schema.project.workflowRunBranches.runId,
          schema.project.workflowRunBranches.branchId,
        ],
        set: {
          currentNodeId: state.currentNodeId,
          status: state.status,
          updatedAt: now,
        },
      });
}

export async function hasWorkflowRunStepInstancesImpl(store: TaskStore, taskId: string): Promise<boolean> {
    if (!store.isBackendMode()) return false;
    return hasWorkflowRunStepInstancesAsyncImpl(store, taskId);
}

export async function hasWorkflowRunStepInstancesAsyncImpl(store: TaskStore, taskId: string): Promise<boolean> {
  const layer = store.asyncLayer!;
  const rows = await layer.db
    .select({ taskId: schema.project.workflowRunStepInstances.taskId })
    .from(schema.project.workflowRunStepInstances)
    .where(eq(schema.project.workflowRunStepInstances.taskId, taskId))
    .limit(1);
  return rows.length > 0;
}

export async function loadWorkflowRunStepInstancesImpl(store: TaskStore,
    taskId: string,
    runId: string,
  ): Promise<import("../types.js").WorkflowRunStepInstance[]> {
    return loadWorkflowRunStepInstancesAsyncImpl(store, taskId, runId);
}

export async function clearWorkflowRunStepInstancesImpl(store: TaskStore, taskId: string, keepRunId?: string): Promise<void> {
    return clearWorkflowRunStepInstancesAsyncImpl(store, taskId, keepRunId);
}

/*
FNXC:WorkflowStepInstancePersistence 2026-07-16-20:20:
PostgreSQL backend mode cannot use the removed synchronous SQLite `store.db`
path. These async siblings preserve the existing identity, pin-clearing, and
stale-run pruning semantics through the Drizzle async layer rather than
silently dropping foreach crash-resume state.
*/
export async function saveWorkflowRunStepInstanceAsyncImpl(
  store: TaskStore,
  state: import("../types.js").WorkflowRunStepInstance,
): Promise<void> {
  const layer = store.asyncLayer!;
  const now = new Date().toISOString();
  await layer.db
    .insert(schema.project.workflowRunStepInstances)
    .values({
      taskId: state.taskId,
      runId: state.runId,
      foreachNodeId: state.foreachNodeId,
      stepIndex: state.stepIndex,
      pinnedStepCount: state.pinnedStepCount,
      currentNodeId: state.currentNodeId ?? null,
      status: state.status,
      baselineSha: state.baselineSha ?? null,
      checkpointId: state.checkpointId ?? null,
      reworkCount: state.reworkCount ?? 0,
      branchName: state.branchName ?? null,
      integratedAt: state.integratedAt ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.project.workflowRunStepInstances.projectId,
        schema.project.workflowRunStepInstances.taskId,
        schema.project.workflowRunStepInstances.runId,
        schema.project.workflowRunStepInstances.foreachNodeId,
        schema.project.workflowRunStepInstances.stepIndex,
      ],
      set: {
        pinnedStepCount: state.pinnedStepCount,
        currentNodeId: state.currentNodeId ?? null,
        status: state.status,
        baselineSha: state.baselineSha ?? null,
        checkpointId: state.checkpointId ?? null,
        reworkCount: state.reworkCount ?? 0,
        branchName: state.branchName ?? null,
        integratedAt: state.integratedAt ?? null,
        updatedAt: now,
      },
      // Terminal foreach state is graph-ownership evidence. A writer that
      // started from an earlier snapshot of the same run/instance may arrive
      // later, but cannot move that row back into pending execution. Terminal
      // incoming writes remain allowed so completed→completed metadata updates
      // (for example integratedAt) still work.
      setWhere: sql`
        ${schema.project.workflowRunStepInstances.status} not in ('completed', 'failed')
        or excluded.status in ('completed', 'failed')
      `,
    });
}

export async function loadWorkflowRunStepInstancesAsyncImpl(
  store: TaskStore,
  taskId: string,
  runId: string,
): Promise<import("../types.js").WorkflowRunStepInstance[]> {
  
  const layer = store.asyncLayer!;
  const rows = await layer.db
    .select()
    .from(schema.project.workflowRunStepInstances)
    .where(and(
      eq(schema.project.workflowRunStepInstances.taskId, taskId),
      eq(schema.project.workflowRunStepInstances.runId, runId),
    ))
    .orderBy(asc(schema.project.workflowRunStepInstances.stepIndex));
  return rows.map((row) => ({
    taskId: row.taskId,
    runId: row.runId,
    foreachNodeId: row.foreachNodeId,
    stepIndex: row.stepIndex,
    pinnedStepCount: row.pinnedStepCount,
    currentNodeId: row.currentNodeId,
    status: row.status as import("../types.js").WorkflowRunStepInstance["status"],
    baselineSha: row.baselineSha,
    checkpointId: row.checkpointId,
    reworkCount: row.reworkCount,
    branchName: row.branchName,
    integratedAt: row.integratedAt,
  }));
}

export async function clearWorkflowRunStepInstancesAsyncImpl(
  store: TaskStore,
  taskId: string,
  keepRunId?: string,
): Promise<void> {
  const layer = store.asyncLayer!;
  await layer.db
    .delete(schema.project.workflowRunStepInstances)
    .where(and(
      eq(schema.project.workflowRunStepInstances.taskId, taskId),
      ...(keepRunId ? [ne(schema.project.workflowRunStepInstances.runId, keepRunId)] : []),
    ));
}

export async function clearWorkflowRunBranchImpl(store: TaskStore, taskId: string, runId: string, branchId: string): Promise<void> {
  const layer = store.asyncLayer!;
  await layer.db
    .delete(schema.project.workflowRunBranches)
    .where(and(
      eq(schema.project.workflowRunBranches.projectId, layer.projectId),
      eq(schema.project.workflowRunBranches.taskId, taskId),
      eq(schema.project.workflowRunBranches.runId, runId),
      eq(schema.project.workflowRunBranches.branchId, branchId),
    ));
}

export async function clearWorkflowRunBranchesImpl(store: TaskStore, taskId: string, runId?: string): Promise<void> {
  const layer = store.asyncLayer!;
  await layer.db
    .delete(schema.project.workflowRunBranches)
    .where(and(
      eq(schema.project.workflowRunBranches.projectId, layer.projectId),
      eq(schema.project.workflowRunBranches.taskId, taskId),
      ...(runId ? [eq(schema.project.workflowRunBranches.runId, runId)] : []),
    ));
}

export async function upsertWorkflowWorkItemImpl(store: TaskStore,
    taskId: string,
    workItem: WorkflowWorkItem,
  ): Promise<void> {
    const layer = store.asyncLayer!;
    const now = new Date().toISOString();
    await layer.db
      .insert(schema.project.workflowWorkItems)
      .values({
        taskId,
        kind: workItem.kind,
        state: workItem.state,
        sourceBranch: workItem.sourceBranch ?? null,
        reviewPayload: workItem.reviewPayload ?? null,
        mergePayload: workItem.mergePayload ?? null,
        createdAt: workItem.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [schema.project.workflowWorkItems.projectId, schema.project.workflowWorkItems.taskId],
        set: {
          kind: workItem.kind,
          state: workItem.state,
          sourceBranch: workItem.sourceBranch ?? null,
          reviewPayload: workItem.reviewPayload ?? null,
          mergePayload: workItem.mergePayload ?? null,
          updatedAt: now,
        },
      });
}

export async function transitionWorkflowWorkItemImpl(store: TaskStore,
    taskId: string,
    expectedState: WorkflowWorkItemState,
    nextState: WorkflowWorkItemState,
    patch?: WorkflowWorkItemTransitionPatch,
  ): Promise<boolean> {
    const layer = store.asyncLayer!;
    const now = new Date().toISOString();
    const updated = await layer.db
      .update(schema.project.workflowWorkItems)
      .set({
        state: nextState,
        ...(patch?.sourceBranch !== undefined ? { sourceBranch: patch.sourceBranch ?? null } : {}),
        ...(patch?.reviewPayload !== undefined ? { reviewPayload: patch.reviewPayload ?? null } : {}),
        ...(patch?.mergePayload !== undefined ? { mergePayload: patch.mergePayload ?? null } : {}),
        updatedAt: now,
      })
      .where(and(
        eq(schema.project.workflowWorkItems.projectId, layer.projectId),
        eq(schema.project.workflowWorkItems.taskId, taskId),
        eq(schema.project.workflowWorkItems.state, expectedState),
      ))
      .returning({ taskId: schema.project.workflowWorkItems.taskId });
    return updated.length > 0;
}

export async function removeWorkflowWorkItemImpl(store: TaskStore, taskId: string): Promise<void> {
    const layer = store.asyncLayer!;
    await layer.db
      .delete(schema.project.workflowWorkItems)
      .where(and(
        eq(schema.project.workflowWorkItems.projectId, layer.projectId),
        eq(schema.project.workflowWorkItems.taskId, taskId),
      ));
}

export async function upsertWorkflowWorkItemWithEntryImpl(store: TaskStore,
    taskId: string,
    workItem: WorkflowWorkItem,
  ): Promise<boolean> {
    const layer = store.asyncLayer!;
    const now = new Date().toISOString();
    try {
      await layer.db.transaction(async (tx) => {
        const transition = await tx
          .select({
            projectId: schema.project.tasks.projectId,
            taskId: schema.project.tasks.id,
          })
          .from(schema.project.tasks)
          .where(and(
            eq(schema.project.tasks.projectId, layer.projectId),
            eq(schema.project.tasks.id, taskId),
          ))
          .for("update")
          .limit(1);
        if (transition.length === 0) return;
        const first = transition[0];
        if (!first) return;
        await tx
          .insert(schema.project.workflowWorkItems)
          .values({
            projectId: layer.projectId,
            taskId,
            kind: workItem.kind,
            state: workItem.state,
            sourceBranch: workItem.sourceBranch ?? null,
            reviewPayload: workItem.reviewPayload ?? null,
            mergePayload: workItem.mergePayload ?? null,
            createdAt: workItem.createdAt ?? now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [schema.project.workflowWorkItems.projectId, schema.project.workflowWorkItems.taskId],
            set: {
              kind: workItem.kind,
              state: workItem.state,
              sourceBranch: workItem.sourceBranch ?? null,
              reviewPayload: workItem.reviewPayload ?? null,
              mergePayload: workItem.mergePayload ?? null,
              updatedAt: now,
            },
          });
      });
    } catch (error) {
      storeLog.warn(`[workflow-work-item] failed upsert for ${taskId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
    return true;
}

export async function finishTaskWithReviewImpl(store: TaskStore, taskId: string): Promise<void> {
    const current = await store.getTask(taskId);
    if (!current) return;
    const columns = await resolveTaskLifecycleColumns(store, taskId);
    const doneColumn = columns?.complete ?? "done";
    const target = current.column === doneColumn ? current.column : doneColumn;
    if (current.column !== target) {
      await store.moveTask(taskId, target, {
        moveSource: "engine",
        preserveProgress: true,
      });
    }
}

export async function advanceTaskAfterReviewImpl(store: TaskStore, taskId: string): Promise<void> {
    const current = await store.getTask(taskId);
    if (!current) return;
    const columns = await resolveTaskLifecycleColumns(store, taskId);
    const target = columns?.integration ?? "merge";
    if (current.column !== target) {
      await store.moveTask(taskId, target, {
        moveSource: "engine",
        preserveProgress: true,
      });
    }
}

export async function moveTaskToReviewImpl(store: TaskStore, taskId: string): Promise<void> {
    const current = await store.getTask(taskId);
    if (!current) return;
    const columns = await resolveTaskLifecycleColumns(store, taskId);
    const target = columns?.review ?? "review";
    if (current.column !== target) {
      await store.moveTask(taskId, target, {
        moveSource: "engine",
        preserveProgress: true,
      });
    }
}

export async function getWorkflowWorkItemStateImpl(store: TaskStore, taskId: string): Promise<WorkflowWorkItemState | null> {
    const item = await store.getWorkflowWorkItem(taskId);
    return item?.state ?? null;
}

export async function listWorkflowWorkItemsByStateImpl(store: TaskStore, state: WorkflowWorkItemState): Promise<WorkflowWorkItem[]> {
    return store.listWorkflowWorkItems(state);
}

export async function countWorkflowWorkItemsByStateImpl(store: TaskStore, state: WorkflowWorkItemState): Promise<number> {
    return (await store.listWorkflowWorkItems(state)).length;
}
