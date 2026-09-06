import { afterEach, describe, expect, it, vi } from "vitest";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileScopeViolationError } from "../merge/merger-file-scope.js";
import { resolveRepoDeclaredScopeTransform } from "../merge/merger-ai-squash-gates.js";

const policy = vi.hoisted(() => vi.fn());
vi.mock("../merge/merge-trait.js", () => ({ resolveMergePolicy: policy }));
const verification = vi.hoisted(() => vi.fn());
vi.mock("../execution/verification-utils.js", async (original) => ({
  ...await original<typeof import("../execution/verification-utils.js")>(),
  runVerificationCommand: verification,
}));

import { resolveAiMergeRoot, runAiMerge } from "../merge/merger-ai.js";

const dirs: string[] = [];
afterEach(() => {
  policy.mockReset();
  verification.mockReset();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8" }).trim();
}

function createRepo(change: (dir: string) => void): string {
  const dir = mkdtempSync(join(tmpdir(), "fusion ai squash gates "));
  dirs.push(dir);
  git(dir, "init -q -b main");
  git(dir, "config user.email test@example.com");
  git(dir, "config user.name Test");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git(dir, "add -A && git commit -q -m base");
  git(dir, "checkout -q -b fusion/fn-9050");
  change(dir);
  git(dir, "add -A && git commit -q -m feature");
  git(dir, "checkout -q main");
  return dir;
}

function makeStore(scope: string[], overrides: Record<string, unknown> = {}) {
  const task: any = {
    /* FNXC:RequiredPreMergeSteps 2026-08-23-00:20: merge-mechanics fixture, not a review-gating one.
       The door refuses a card whose enabled optional pre-merge groups produced no result, and the
       built-in workflow enables Plan and Code Review by default, so an unspecified list failed the
       door before the behaviour under test ran. An explicit empty list states the intent. */
    enabledWorkflowSteps: [],
    id: "FN-9050", title: "squash gates", column: "in-review", branch: "fusion/fn-9050",
    comments: [], steeringComments: [], steps: [], log: [], ...overrides,
  };
  const store: any = {
    getTask: vi.fn(async () => task),
    getSettings: vi.fn(async () => ({ merger: { mode: "ai", maxReviewPasses: 0 } })),
    parseFileScopeFromPrompt: vi.fn(async () => scope),
    updateTask: vi.fn(async (_id: string, patch: object) => Object.assign(task, patch)),
    /* FNXC:MergerAiReview 2026-08-22-22:20: FN-159 reconciliation persists every candidate and verdict through the production atomic CAS seam, so this mutable store double must apply its callback patch to the same task returned by getTask. */
    updateTaskAtomic: vi.fn(async (_id: string, mutate: (current: typeof task) => Partial<typeof task> | undefined) => {
      const patch = mutate(task);
      if (patch) Object.assign(task, patch);
      return task;
    }),
    moveTask: vi.fn(async (_id: string, column: string) => Object.assign(task, { column })),
    appendAgentLog: vi.fn(async () => undefined),
    logEntry: vi.fn(async () => undefined),
    emit: vi.fn(),
    recordRunAuditEvent: vi.fn(async () => undefined),
    upsertTaskCommitAssociation: vi.fn(async () => undefined),
    accumulateTokenUsage: vi.fn(async () => undefined),
  };
  return { store, task };
}

function squashAgent(branch: string, mutate?: (cwd: string) => void) {
  return async (cwd: string): Promise<void> => {
    git(cwd, `merge --squash ${branch}`);
    mutate?.(cwd);
    git(cwd, "add -A && git commit -q -m squash");
  };
}

const approve = async () => "REVIEW_VERDICT: approve";

function setPolicy(mode: "strict" | "warn" | "off" = "strict"): void {
  policy.mockResolvedValue({ fileScope: mode, fileScopeRules: [] });
}

describe("resolveRepoDeclaredScopeTransform", () => {
  it("derives repo-local paths and keeps unprefixed scopes as a fallback", () => {
    const scoped = resolveRepoDeclaredScopeTransform({ repoRel: "apps/web", repoKeys: ["apps", "apps/web", "api"] });
    expect(scoped.transform(["./apps/web/src/**", "api/src/**"])).toEqual(["src/**"]);
    expect(scoped.describe(["./apps/web/src/**", "api/src/**"])).toBe("repo-subset");
    expect(scoped.transform(["src/**"])).toEqual(["src/**"]);
    expect(scoped.describe(["src/**"])).toBe("unprefixed-fallback");
  });

  it("identifies declarations owned solely by another repository", () => {
    const transform = resolveRepoDeclaredScopeTransform({ repoRel: "repo-b", repoKeys: ["repo-a", "repo-b"] });
    expect(transform.transform(["repo-a/src/**"])).toEqual([]);
    expect(transform.describe(["repo-a/src/**"])).toBe("foreign-repo-only");
  });
});

describe("runAiMerge approved-squash gates", () => {
  /* FNXC:AIMergeVerification 2026-09-06-02:38: configured checks must execute at the real production pre-land seam, not merely appear in a helper test or model prompt. */
  it("runs explicit test and build exactly once on the approved squash before landing", async () => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "feature.txt"), "feature\n"));
    const before = git(dir, "rev-parse main");
    const { store } = makeStore(["feature.txt"]);
    store.getSettings.mockResolvedValue({ testCommand: "node exact-test.js", buildCommand: "node exact-build.js", verificationCommandTimeoutMs: 1234 });
    verification.mockImplementation(async (_store, cwd, _id, command) => {
      expect(git(dir, "rev-parse main")).toBe(before);
      expect(git(cwd, "rev-parse HEAD")).not.toBe(before);
      return { command, exitCode: 0, success: true, stdout: "", stderr: "" };
    });
    const result = await runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    });
    expect(result.merged).toBe(true);
    expect(verification.mock.calls.map((call) => [call[3], call[4], call[9]])).toEqual([
      ["node exact-test.js", "test", 1234], ["node exact-build.js", "build", 1234],
    ]);
  });

  it.each(["exit", "timeout", "abort", "dirty", "head", "paused", "settings", "episode"])("refuses landing after configured verification %s", async (failure) => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "feature.txt"), "feature\n"));
    const before = git(dir, "rev-parse main");
    const { store, task } = makeStore(["feature.txt"]);
    store.getSettings.mockResolvedValue({ testCommand: "node exact-test.js" });
    verification.mockImplementation(async (_store, cwd, _id, command) => {
      if (failure === "dirty") writeFileSync(join(cwd, "feature.txt"), "mutated\n");
      if (failure === "head") git(cwd, "-c user.name=Test -c user.email=test@example.com commit --allow-empty -m changed");
      if (failure === "paused") task.paused = true;
      if (failure === "settings") store.getSettings.mockResolvedValue({ testCommand: "node different-check.js" });
      if (failure === "episode") task.aiMergeReviewReconciliation = null;
      return { command, exitCode: failure === "exit" ? 1 : 0, success: failure !== "exit",
        timedOut: failure === "timeout", aborted: failure === "abort", stdout: "", stderr: "" };
    });
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    })).rejects.toThrow();
    expect(git(dir, "rev-parse main")).toBe(before);
    expect(task.column).not.toBe("done");
    expect(verification).toHaveBeenCalledOnce();
  });

  it("a passing test never masks a failing required build", async () => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "feature.txt"), "feature\n"));
    const before = git(dir, "rev-parse main");
    const { store, task } = makeStore(["feature.txt"]);
    store.getSettings.mockResolvedValue({ testCommand: "node focused-test.js", buildCommand: "node focused-build.js" });
    verification.mockResolvedValueOnce({ exitCode: 0, success: true }).mockResolvedValueOnce({ exitCode: 1, success: false });
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    })).rejects.toThrow("verification failed: build");
    expect(verification).toHaveBeenCalledTimes(2);
    expect(git(dir, "rev-parse main")).toBe(before);
    expect(task.column).not.toBe("done");
  });

  it.each([0, 1])("verifies a recovered approved clean-room candidate (exit %s)", async (exitCode) => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "feature.txt"), "feature\n"));
    const before = git(dir, "rev-parse main");
    const parent = resolveAiMergeRoot(dir);
    mkdirSync(parent, { recursive: true });
    const cleanRoom = mkdtempSync(join(parent, "fusion-ai-merge-fn-9050-"));
    git(dir, `worktree add --detach "${cleanRoom}" ${before}`);
    git(cleanRoom, "merge --squash fusion/fn-9050");
    git(cleanRoom, 'add -A && git commit -q -m squash -m "Fusion-Task-Id: FN-9050"');
    const squashSha = git(cleanRoom, "rev-parse HEAD");
    const { store, task } = makeStore(["feature.txt"]);
    task.aiMergeReviewReconciliation = {
      sourceSha: git(dir, "rev-parse fusion/fn-9050"), integrationTipSha: before,
      candidateSha: squashSha, candidateTreeSha: git(cleanRoom, 'rev-parse "HEAD^{tree}"'),
      findings: [], consecutiveCleanApprovals: 2, correctivePasses: 0,
    };
    store.getSettings.mockResolvedValue({ testCommand: "node exact-test.js" });
    verification.mockImplementation(async (_store, cwd) => {
      expect(cwd).toBe(cleanRoom);
      expect(git(dir, "rev-parse main")).toBe(before);
      return { exitCode, success: exitCode === 0 };
    });
    const mergeAgent = vi.fn(async () => { throw new Error("must recover without re-merging"); });
    const result = runAiMerge(store, dir, "FN-9050", { manual: true }, { mergeAgent, reviewAgent: approve });
    if (exitCode) {
      await expect(result).rejects.toThrow("verification failed");
      expect(git(dir, "rev-parse main")).toBe(before);
      expect(task.column).not.toBe("done");
    } else {
      expect((await result).merged).toBe(true);
      expect(git(dir, "rev-parse main")).toBe(squashSha);
    }
    expect(verification).toHaveBeenCalledOnce();
    expect(mergeAgent).not.toHaveBeenCalled();
  });

  it("blocks a strict out-of-scope squash before main advances and records the violation", async () => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const before = git(dir, "rev-parse main");
    const { store } = makeStore(["allowed/**"]);

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(git(dir, "rev-parse main")).toBe(before);
    expect(store.recordRunAuditEvent.mock.calls.some(([event]: any[]) => event.mutationType === "merge:file-scope-violation")).toBe(true);
  });

  it.each([
    ["warn", false, "merge:file-scope-violation"],
    ["off", false, "merge:file-scope-enforcement-disabled"],
    ["strict", true, "merge:ai-landed"],
  ] as const)("preserves %s and scopeOverride file-scope behavior", async (mode, scopeOverride, auditType) => {
    setPolicy(mode);
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const { store } = makeStore(["allowed/**"], scopeOverride ? { scopeOverride: true } : {});

    const result = await runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: squashAgent("fusion/fn-9050"), reviewAgent: approve,
    });

    expect(result.merged).toBe(true);
    expect(store.recordRunAuditEvent.mock.calls.some(([event]: any[]) => event.mutationType === auditType)).toBe(true);
    if (scopeOverride) expect(store.appendAgentLog).toHaveBeenCalledWith("FN-9050", expect.stringContaining("scopeOverride"), "status", undefined, "merger");
  });

  it("resets a recovered strict scope violation so a retry does not select it again", async () => {
    setPolicy();
    const dir = createRepo((root) => writeFileSync(join(root, "outside.txt"), "outside\n"));
    const before = git(dir, "rev-parse main");
    const cleanRoomParent = resolveAiMergeRoot(dir);
    mkdirSync(cleanRoomParent, { recursive: true });
    const cleanRoom = mkdtempSync(join(cleanRoomParent, "fusion-ai-merge-fn-9050-"));
    git(dir, `worktree add --detach "${cleanRoom}" ${before}`);
    git(cleanRoom, "merge --squash fusion/fn-9050");
    git(cleanRoom, 'add -A && git commit -q -m squash -m "Fusion-Task-Id: FN-9050"');
    const squashSha = git(cleanRoom, "rev-parse HEAD");
    const { store, task } = makeStore(["allowed/**"]);
    /*
    FNXC:AIMergeReviewReconciliation 2026-08-23-21:50:
    FN-090 (f714e45bda) made the DURABLE reconciliation record the sole authority for reviving a
    pre-existing clean room: recovery admits only a twice-confirmed candidate whose source and
    integration identities still match. Task-log prose is audit history and is deliberately no
    longer sufficient, so this fixture states the approval the way the product now records it —
    seeding the old log line instead meant recovery selected nothing and the merge agent ran.
    */
    task.aiMergeReviewReconciliation = {
      sourceSha: git(dir, "rev-parse --verify fusion/fn-9050"),
      integrationTipSha: before,
      candidateSha: squashSha,
      candidateTreeSha: git(cleanRoom, 'rev-parse "HEAD^{tree}"'),
      findings: [],
      consecutiveCleanApprovals: 2,
      correctivePasses: 0,
    };

    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: async () => { throw new Error("recovery should not re-merge"); }, reviewAgent: approve,
    })).rejects.toBeInstanceOf(FileScopeViolationError);

    expect(git(cleanRoom, "rev-parse HEAD")).toBe(before);
    task.status = null;
    const normalMerge = vi.fn(async () => { throw new Error("normal merge invoked"); });
    await expect(runAiMerge(store, dir, "FN-9050", { manual: true }, {
      mergeAgent: normalMerge, reviewAgent: approve,
    })).rejects.toThrow("normal merge invoked");
    expect(normalMerge).toHaveBeenCalledOnce();
  });
});
