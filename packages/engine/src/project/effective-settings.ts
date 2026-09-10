/**
 * Engine-side helper: merge per-task EFFECTIVE workflow settings (U3, KTD-3) over a
 * base settings object fetched from the store, so the engine's flat
 * `settings.<key>` read sites pick up workflow-setting values with zero changes at
 * the read sites.
 *
 * TWO-TIER MERGE (the parity-preserving rule):
 *  - a STORED flat value ALWAYS overrides the base (workflow policy, or the
 *    project workflow-model baseline);
 *  - a declaration-DEFAULT-only key (no stored value) only FILLS the base when the
 *    base lacks the key.
 *
 * This is what keeps U3 behavior-identical BEFORE the U4 hard-move: a customized
 * project setting still present in the base is NOT clobbered by a declaration
 * default; only a real stored workflow value overrides it. After the hard-move the
 * base lacks the moved key, so the declaration default fills it. Absent-default
 * model lanes contribute nothing. Lower-precedence selected-workflow model lanes
 * are retained separately for the centralized model resolver.
 *
 * `resolveEffectiveSettingsDetailed` never throws (degrades to declaration
 * defaults), so this helper is a thin store-coupled wrapper that also never throws.
 */

import {
  applyWorkflowSettingsOverlay,
  resolveEffectiveSettingsDetailed,
  resolveProjectWorkflowModelLaneBaseline,
  type Settings,
  type TaskStore,
} from "@fusion/core";

/** The minimal task shape the resolver needs. Task carries no projectId field —
 *  the project key is derived from the store. */
export interface EffectiveSettingsTask {
  id: string;
}

type WorkflowAuthorityReadStage =
  | "task selection"
  | "project identity"
  | "workflow definition"
  | "workflow setting values"
  | "default workflow"
  | "workflow prompt overrides";

/**
 * A merge-review caller must not approve using an unverified fallback route.
 * The public workflow resolver deliberately remains never-throw for normal
 * execution, so this error contains only the fixed failed-read category, never
 * a backend error message, connection string, or provider response.
 */
export class WorkflowSettingsAuthorityReadError extends Error {
  constructor(stage: WorkflowAuthorityReadStage) {
    super(`Merge-review workflow-settings authority read failed (${stage}); refusing fallback routing.`);
    this.name = "WorkflowSettingsAuthorityReadError";
  }
}

/**
 * FNXC:MergeReviewWorkflowAuthority 2026-09-10-00:31:
 * Merge review is an authority-bearing route, while existing engine entry points
 * intentionally retain the resolver's fail-soft behavior. Observe only the
 * resolver's public workflow reads, bind each read to the actual store, and let
 * the established resolver run its one precedence algorithm. A captured failure
 * is raised only by the opt-in helper below, after the compatibility resolver
 * finishes; no base/global fallback can silently stand in for configured review
 * policy. Missing selection remains a valid built-in default, but a missing
 * required read or an empty project identity is not evidence of that default.
 */
function observeWorkflowAuthorityReads<TStore extends object>(store: TStore): {
  store: TStore;
  failure(): WorkflowAuthorityReadStage | undefined;
} {
  let failedStage: WorkflowAuthorityReadStage | undefined;
  const recordFailure = (stage: WorkflowAuthorityReadStage): void => {
    failedStage ??= stage;
  };
  const source = store as Record<string, unknown>;
  const observed = Object.create(store) as Record<string, unknown>;

  const syncRead = (name: string, stage: WorkflowAuthorityReadStage, requireValue = false): void => {
    observed[name] = (...args: unknown[]) => {
      try {
        const read = source[name];
        if (typeof read !== "function") {
          recordFailure(stage);
          throw new Error("workflow authority reader unavailable");
        }
        const value = (read as (...readArgs: unknown[]) => unknown).apply(store, args);
        if (requireValue && (typeof value !== "string" || value.trim().length === 0)) {
          recordFailure(stage);
          throw new Error("workflow authority identity unavailable");
        }
        if (value && typeof (value as PromiseLike<unknown>).then === "function") {
          return Promise.resolve(value).catch((error) => {
            recordFailure(stage);
            throw error;
          });
        }
        return value;
      } catch (error) {
        recordFailure(stage);
        throw error;
      }
    };
  };

  const asyncRead = (
    name: string,
    stage: WorkflowAuthorityReadStage,
    optional = true,
    requireValue = false,
  ): void => {
    try {
      if (typeof source[name] !== "function" && optional) return;
    } catch (error) {
      recordFailure(stage);
      return;
    }
    observed[name] = async (...args: unknown[]) => {
      try {
        const read = source[name];
        if (typeof read !== "function") {
          recordFailure(stage);
          throw new Error("workflow authority reader unavailable");
        }
        const value = await (read as (...readArgs: unknown[]) => Promise<unknown>).apply(store, args);
        if (requireValue && value === undefined) {
          recordFailure(stage);
          throw new Error("workflow authority reader returned no definition");
        }
        return value;
      } catch (error) {
        recordFailure(stage);
        throw error;
      }
    };
  };

  syncRead("getTaskWorkflowSelection", "task selection");
  asyncRead("getTaskWorkflowSelectionAsync", "task selection");
  syncRead("getWorkflowSettingsProjectId", "project identity", true);
  syncRead("getWorkflowSettingValues", "workflow setting values");
  asyncRead("getWorkflowSettingValuesAsync", "workflow setting values");
  asyncRead("getWorkflowDefinition", "workflow definition", false, true);
  asyncRead("getDefaultWorkflowId", "default workflow");
  try {
    if (typeof source.getWorkflowPromptOverrides === "function") {
      syncRead("getWorkflowPromptOverrides", "workflow prompt overrides");
    }
  } catch (error) {
    recordFailure("workflow prompt overrides");
  }
  asyncRead("getWorkflowPromptOverridesAsync", "workflow prompt overrides");

  return { store: observed as TStore, failure: () => failedStage };
}

/**
 * Merge `base` with the task's effective workflow settings via the two-tier rule
 * (stored overrides; default-only fills only-absent). Returns a NEW object; `base`
 * is not mutated. Degrades to returning `base` unchanged on any resolver error.
 */
export async function mergeEffectiveSettings<T extends Partial<Settings>>(
  store: Pick<
    TaskStore,
    | "getDefaultWorkflowId"
    | "getTaskWorkflowSelection"
    | "getTaskWorkflowSelectionAsync"
    | "getWorkflowDefinition"
    | "getWorkflowSettingValues"
    | "getWorkflowSettingsProjectId"
  >,
  task: EffectiveSettingsTask,
  base: T,
): Promise<T> {
  try {
    const detailed = await resolveEffectiveSettingsDetailed(
      store as Parameters<typeof resolveEffectiveSettingsDetailed>[0],
      task,
    );
    return applyWorkflowSettingsOverlay(base, detailed);
  } catch {
    return base;
  }
}

/**
 * Merge settings for the authority-bearing merge-review route. Unlike
 * {@link mergeEffectiveSettings}, this opt-in variant rejects if any public
 * workflow-authority read failed or project identity was unusable. Its error is
 * bounded and sanitized; normal callers retain their established fail-soft API.
 */
export async function mergeEffectiveSettingsStrict<T extends Partial<Settings>>(
  store: Pick<
    TaskStore,
    | "getDefaultWorkflowId"
    | "getTaskWorkflowSelection"
    | "getTaskWorkflowSelectionAsync"
    | "getWorkflowDefinition"
    | "getWorkflowSettingValues"
    | "getWorkflowSettingsProjectId"
    | "getWorkflowPromptOverrides"
    | "getWorkflowPromptOverridesAsync"
  >,
  task: EffectiveSettingsTask,
  base: T,
): Promise<T> {
  const observed = observeWorkflowAuthorityReads(store);
  let detailed: Awaited<ReturnType<typeof resolveEffectiveSettingsDetailed>>;
  try {
    detailed = await resolveEffectiveSettingsDetailed(
      observed.store as Parameters<typeof resolveEffectiveSettingsDetailed>[0],
      task,
    );
  } catch (error) {
    const failedStage = observed.failure();
    if (failedStage) throw new WorkflowSettingsAuthorityReadError(failedStage);
    throw error;
  }
  const failedStage = observed.failure();
  if (failedStage) throw new WorkflowSettingsAuthorityReadError(failedStage);
  return applyWorkflowSettingsOverlay(base, detailed);
}

/** Merge the Project Models workflow-lane baseline when no task-selected
 * workflow exists, such as scheduled AI prompts and idle heartbeats. */
export async function mergeProjectWorkflowModelLaneBaseline<T extends Partial<Settings>>(
  store: Pick<
    TaskStore,
    | "getDefaultWorkflowId"
    | "getWorkflowDefinition"
    | "getWorkflowSettingValues"
    | "getWorkflowSettingsProjectId"
  >,
  base: T,
): Promise<T> {
  try {
    const detailed = await resolveProjectWorkflowModelLaneBaseline(
      store as Parameters<typeof resolveProjectWorkflowModelLaneBaseline>[0],
      store.getWorkflowSettingsProjectId(),
    );
    return applyWorkflowSettingsOverlay(base, detailed);
  } catch {
    return base;
  }
}
