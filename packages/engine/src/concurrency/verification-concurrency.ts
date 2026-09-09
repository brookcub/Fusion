/*
FNXC:VerificationConcurrency 2026-07-15-03:35:
Multiple in-progress tasks each calling fn_run_verification (often `pnpm verify:fast` / full typecheck+build) pegged CPU by running several monorepo compiles in parallel. Cap concurrent verification subprocesses project-wide so task concurrency can stay higher without stacking heavy builds. Default limit is 1; operators raise maxConcurrentVerifications when the machine has spare cores.

FNXC:VerificationConcurrency 2026-07-15-08:20:
Greptile P1/P2: (1) clamp 1–8 so programmatic settings cannot open 50 slots; (2) do not re-set the process limit on every verification start (multi-project races last-writer-wins) — wire the limit from engine settings load/update only; (3) honor AbortSignal while queued so cancelled merge/verification does not block the slot queue.

FNXC:VerificationConcurrency 2026-07-15-09:05:
Greptile P1 multi-project: multiple ProjectEngine instances must not last-write the singleton limit. Register each project's desired cap; the effective process limit is the MIN of registered caps (most restrictive wins) so a project set to 1 cannot be overridden by a peer set to 8.
*/
import { randomUUID } from "node:crypto";
import { AgentSemaphore, PRIORITY_EXECUTE } from "./concurrency.js";

/** Hard ceiling matching the Scheduling UI max. */
export const MAX_CONCURRENT_VERIFICATIONS_HARD_CAP = 8;
/** Floor — at least one verification can always run. */
export const MIN_CONCURRENT_VERIFICATIONS = 1;
/** Queue admission is bounded independently of the command's own timeout. */
export const DEFAULT_VERIFICATION_QUEUE_TIMEOUT_MS = 300_000;
export type VerificationSlotOwnerKind = "merger" | "verification-tool" | "mission" | "executor";
export type VerificationSlotState = "queued" | "running" | "settled";
export interface VerificationSlotReceipt {
  attemptId: string;
  projectId: string;
  taskId: string;
  ownerKind: VerificationSlotOwnerKind;
  state: VerificationSlotState;
  queuedAt: string;
  queueDeadlineAt: string;
  startedAt?: string;
  settledAt?: string;
  /** Slot-body settlement, not a verification-pass verdict. */
  outcome?: "completed" | "cancelled" | "queue-timeout" | "failed";
}
export interface VerificationSlotOptions {
  signal?: AbortSignal;
  taskId: string;
  projectId?: string;
  ownerKind: VerificationSlotOwnerKind;
  queueTimeoutMs?: number;
  onState?: (receipt: VerificationSlotReceipt) => void | Promise<void>;
}
/** Diagnostic identity may be unavailable in legacy/test stores; never invent a project. */
export function resolveVerificationProjectId(store: { getWorkflowSettingsProjectId?: () => string }): string | undefined {
  try {
    const value = store.getWorkflowSettingsProjectId?.();
    return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}
export class VerificationQueueTimeoutError extends Error {
  constructor() { super("verification queue timeout"); this.name = "VerificationQueueTimeoutError"; }
}
function abortError(): Error {
  const error = new Error("verification cancelled");
  error.name = "AbortError";
  return error;
}
const verificationReceipts = new Map<string, VerificationSlotReceipt>();
const settledVerificationReceipts: VerificationSlotReceipt[] = [];
const processInstanceId = randomUUID();
function stamp(): string { return new Date().toISOString(); }
function notify(config: VerificationSlotOptions | undefined, receipt: VerificationSlotReceipt): void {
  // Non-blocking observers may throw/reject or never settle. None is awaited by
  // admission or release; the process-local registry remains the live authority.
  try { void Promise.resolve(config?.onState?.({ ...receipt })).catch(() => {}); }
  catch { /* observational only */ }
}
function settleReceipt(key: string, outcome: NonNullable<VerificationSlotReceipt["outcome"]>, config?: VerificationSlotOptions): void {
  const receipt = verificationReceipts.get(key);
  if (!receipt) return;
  verificationReceipts.delete(key);
  const settled: VerificationSlotReceipt = { ...receipt, state: "settled", settledAt: stamp(), outcome };
  settledVerificationReceipts.push(settled);
  if (settledVerificationReceipts.length > 32) settledVerificationReceipts.splice(0, settledVerificationReceipts.length - 32);
  notify(config, settled);
}
/** Process-local truth only; a restart deliberately starts with no active waiter. */
export function getVerificationQueueSnapshot(projectId?: string) {
  const matchesProject = (receipt: VerificationSlotReceipt) => projectId === undefined || receipt.projectId === projectId;
  return {
    processInstanceId,
    active: [...verificationReceipts.values()].filter(matchesProject).map((r) => ({ ...r })),
    settled: settledVerificationReceipts.filter(matchesProject).map((r) => ({ ...r })),
    // The cap and semaphore counts are process-wide, even in a project-filtered view.
    countScope: "process" as const,
    limit: verificationSemaphore.limit,
    activeCount: verificationSemaphore.activeCount,
    waitingCount: verificationSemaphore.waitingCount,
  };
}

/** projectId -> clamped desired limit for that engine instance */
const projectLimits = new Map<string, number>();
let fallbackLimit = MIN_CONCURRENT_VERIFICATIONS;
const verificationSemaphore = new AgentSemaphore(() => resolveEffectiveLimit());

/**
 * Clamp a raw setting/API value into the enforced verification concurrency range.
 */
export function clampMaxConcurrentVerifications(next: number): number {
  if (!Number.isFinite(next)) return MIN_CONCURRENT_VERIFICATIONS;
  return Math.min(
    MAX_CONCURRENT_VERIFICATIONS_HARD_CAP,
    Math.max(MIN_CONCURRENT_VERIFICATIONS, Math.floor(next)),
  );
}

function resolveEffectiveLimit(): number {
  if (projectLimits.size === 0) return fallbackLimit;
  let min = MAX_CONCURRENT_VERIFICATIONS_HARD_CAP;
  for (const value of projectLimits.values()) {
    if (value < min) min = value;
  }
  return min;
}

/**
 * Register or update one project's desired verification concurrency.
 * Effective process limit = min(registered project caps).
 */
export function registerProjectVerificationLimit(projectId: string, next: number): void {
  if (!projectId) return;
  projectLimits.set(projectId, clampMaxConcurrentVerifications(next));
}

/**
 * Drop a project's registration when its engine stops so stale caps do not pin the min forever.
 */
export function unregisterProjectVerificationLimit(projectId: string): void {
  if (!projectId) return;
  projectLimits.delete(projectId);
}

/**
 * Legacy setter used by tests and single-engine paths without a project id.
 * Sets the fallback limit when no projects are registered; when projects are
 * registered this is ignored for the effective min (use registerProjectVerificationLimit).
 */
export function setMaxConcurrentVerifications(next: number): void {
  fallbackLimit = clampMaxConcurrentVerifications(next);
}

/** Current effective verification concurrency limit (after clamping / min aggregation). */
export function getMaxConcurrentVerifications(): number {
  return verificationSemaphore.limit;
}

/** Test helper: clear project registrations. */
export function resetVerificationLimitRegistryForTests(): void {
  projectLimits.clear();
  fallbackLimit = MIN_CONCURRENT_VERIFICATIONS;
  verificationReceipts.clear();
  settledVerificationReceipts.splice(0);
}

/**
 * Run `fn` while holding one verification slot. Waiters queue at execute priority.
 * When `signal` aborts while queued, the waiter is removed and the promise rejects
 * with AbortError so cancelled work does not block the queue.
 */
export async function withVerificationSlot<T>(
  fn: () => Promise<T>,
  options?: AbortSignal | VerificationSlotOptions,
): Promise<T> {
  const config = options && typeof options === "object" && "ownerKind" in options ? options : undefined;
  const legacySignal = config ? undefined : options as AbortSignal | undefined;
  const signal = config?.signal ?? legacySignal;
  const timeoutMs = config?.queueTimeoutMs ?? DEFAULT_VERIFICATION_QUEUE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_VERIFICATION_QUEUE_TIMEOUT_MS) {
    throw new Error("verification queue timeout must be a positive integer within the configured maximum");
  }
  if (signal?.aborted) throw abortError();
  const key = config ? randomUUID() : undefined;
  const controller = new AbortController();
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  if (key && config) {
    const receipt: VerificationSlotReceipt = {
      attemptId: key, projectId: config.projectId ?? "unscoped", taskId: config.taskId,
      ownerKind: config.ownerKind, state: "queued", queuedAt: stamp(),
      queueDeadlineAt: new Date(Date.now() + timeoutMs).toISOString(),
    };
    verificationReceipts.set(key, receipt);
    notify(config, receipt);
  }
  let acquired = false;
  let outcome: NonNullable<VerificationSlotReceipt["outcome"]> = "failed";
  try {
    /*
    FNXC:VerificationQueue 2026-09-09-12:00:
    Concurrent tickets need a visible, finite verification wait. Queue expiry
    removes the actual semaphore waiter; it never runs the command later. Once
    admitted, only the existing command deadline applies. Abort racing admission
    must release the acquired slot exactly once before refusing execution.
    */
    await verificationSemaphore.acquire(PRIORITY_EXECUTE, controller.signal);
    acquired = true;
    clearTimeout(timer); // Queue bound ends at admission; command keeps its own deadline.
    if (controller.signal.aborted) throw abortError();
    if (key && config) {
      const receipt = verificationReceipts.get(key);
      if (receipt) {
        receipt.state = "running";
        receipt.startedAt = stamp();
        notify(config, receipt);
      }
    }
    // A synchronous observer may itself request cancellation.
    if (controller.signal.aborted) throw abortError();
    const value = await fn();
    if (controller.signal.aborted) throw abortError();
    outcome = "completed";
    return value;
  } catch (error) {
    outcome = timedOut ? "queue-timeout" : controller.signal.aborted ? "cancelled" : "failed";
    if (timedOut) throw new VerificationQueueTimeoutError();
    if (controller.signal.aborted) throw abortError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
    if (acquired) verificationSemaphore.release();
    if (key) settleReceipt(key, outcome, config);
  }
}

/** Test/diagnostic access to the underlying semaphore. */
export function getVerificationSemaphore(): AgentSemaphore {
  return verificationSemaphore;
}
