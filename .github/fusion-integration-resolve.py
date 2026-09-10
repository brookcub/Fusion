# Temporary integration workbench; removed from the final PR tree.
from pathlib import Path
import subprocess, re, json
root = Path.cwd()
def upstream(path):
    return subprocess.check_output(['git', 'show', 'upstream-snapshot:' + path], cwd=root, text=True)
def edit(path, fn):
    p = root / path
    p.write_text(fn(p.read_text()))
pat = r'^<<<<<<< HEAD\n(.*?)^=======\n(.*?)^>>>>>>> upstream-snapshot\n'
def resolve(path, choices):
    def run(s):
        i = iter(choices)
        def choose(m):
            fn = next(i)
            return fn(m[1], m[2]) if callable(fn) else [m[1], m[2]][fn]
        result = re.sub(pat, choose, s, flags=re.M | re.S)
        assert next(i, None) is None, path
        return result
    edit(path, run)
resolve('packages/cli/src/commands/dashboard.ts', [lambda a,b: a.replace('await phaseTime(', 'await boundedPhaseTime(')])
resolve('packages/core/src/store.ts', [lambda a,b: b.replace('TaskLogEntry,', 'TaskLogEntry, TaskLogEntryWriteOptions,')])
resolve('packages/core/src/task-store/audit-ops.ts', [lambda a,b: b.replace('new Error(`Task ${id} not found`)', 'new TaskNotFoundError(id)')])
resolve('packages/core/src/task-store/reads.ts', [lambda a,b: '''      // Every query dimension belongs to the caller-scoped startup memo key.
      const memoKey = JSON.stringify([
        includeArchived, options?.includeDeleted === true, columnFilter ?? null,
        options?.columns ?? null, options?.excludeColumns ?? null, options?.sort ?? "created-asc",
      ]);
'''])
resolve('packages/engine/src/auth/auth-storage.ts', [lambda a,b: a.replace('this.data = this.readCurrent();', 'this.data = this.readCurrent(); this.fileStamp = this.readFileStamp();'), 1, 1])
edit('packages/engine/src/auth/auth-storage.ts', lambda s: s.replace('  private revalidate(): void {\n', '  private revalidate(): void {\n    if (this.externalCredentials) { this.data = this.externalCredentials(); return; }\n'))
for path in ['packages/engine/src/executor/mark-stuck-aborted.ts', 'packages/engine/src/__tests__/executor-stuck-requeue-preserve-progress.test.ts', 'packages/engine/src/__tests__/workflow-graph-optional-step-fix.test.ts']:
    (root / path).write_text(upstream(path))
resolve('packages/engine/src/executor/deps-bags.ts', [1])
resolve('packages/engine/src/__tests__/executor-test-helpers.ts', [lambda a,b: a.replace('planRemediationPlacement,', 'DEFAULT_MAX_POST_REVIEW_FIXES, planRemediationPlacement,')])
resolve('packages/engine/src/__tests__/worktree-backend.test.ts', [lambda a,b: a.replace('readdir: vi.fn(async () => []),', 'readdir: readdirMock,')])
resolve('packages/engine/src/executor/recover-failed-pre-merge-step.ts', [lambda a,b: b.replace('hasPreMergeRemediationAutoMergeHold,', 'hasPreMergeRemediationAutoMergeHold, requiresAuthoredReviewVerdict,')])
resolve('packages/engine/src/runtimes/in-process-runtime.ts', [1, lambda a,b: '''      const isPlannerLive = (taskId: string) => isTaskPlanningOrExecutionLive(taskId, {
        activeSessionRegistry: { pathsForTask: () => [], isPathActive: () => false },
        executingTaskLock: { has: () => false },
        isTaskActive: () => false,
        getPlanningTaskIds: () => this.triageProcessor?.getPlanningTaskIds() ?? new Set<string>(),
      });
'''])
p = 'packages/engine/src/executor/run-implementation.ts'
s = upstream(p)
s = s.replace('import { summarizeVerificationOutput } from "../execution/verification-utils.js";', 'import { summarizeVerificationOutput } from "../execution/verification-utils.js";\nimport { resolveVerificationProjectId } from "../concurrency/verification-concurrency.js";\nimport { recoveryIsHeld } from "./recovery-pause-guard.js";')
s = s.replace('pendingStepSessionInPlaceResume', 'pendingInPlaceResume')
s = s.replace('    let pendingInPlaceResume = false;', '    let pendingInPlaceResume = false;\n    const implementationAbortSignal = deps.activeWorkflowGraphAbortControllers.get(task.id)?.signal;')
s = s.replace('          recordActivity: () => stuckDetector?.recordActivity(task.id),', '''          recordActivity: () => stuckDetector?.recordActivity(task.id),
          projectId: resolveVerificationProjectId(deps.store),
          onVerificationState: async (receipt) => { await deps.store.logEntry(task.id,
            `[verification-queue] state=${receipt.state}; owner=${receipt.ownerKind}; attempt=${receipt.attemptId}; outcome=${receipt.outcome ?? "pending"}`); },''')
needle = '\n      const { message: errorMessage, detail: errorDetail, stack: errorStack } = formatError(err);'
assert s.count(needle) == 1
s = s.replace(needle, needle + '''
      if (!executingTaskLock.owns(executionLease) || await recoveryIsHeld(deps.store, task.id)) return;
      if (implementationAbortSignal?.aborted) {
        pendingInPlaceResume = (await recoverAbortedStepSessionInPlace(
          deps, task.id, "pause-abort",
        )) === "resumed-in-place";
        return;
      }''')
(root / p).write_text(s)
resolve('scripts/lib/test-quarantine.json', [lambda a,b: a + '\n    },\n    {\n' + b])
json.loads((root / 'scripts/lib/test-quarantine.json').read_text())
p = 'packages/engine/src/__tests__/workflow-graph-optional-step-fix.test.ts'
s = (root / p).read_text().replace('status: "failed",\n        output: "Fix the review finding.",', 'status: "failed",\n        verdict: "REVISE",\n        output: "Fix the review finding.",')
(root / p).write_text(s)
remaining = []
for path in subprocess.check_output(['git', 'diff', '--name-only', '--diff-filter=U'], cwd=root, text=True).splitlines():
    if re.search(r'^<<<<<<<|^=======|^>>>>>>>', (root / path).read_text(), re.M):
        remaining.append(path)
assert not remaining, remaining
subprocess.run(['git', 'add', '-u'], cwd=root, check=True)
tree = subprocess.check_output(['git', 'write-tree'], text=True).strip()
for name, expected in {'packages': '692d12d590aa54e05b1d50f217afe8d54c69b12c', 'plugins': 'e9df378accff64df5538dfa02d3d2d2613cb2e12', 'scripts': '34c1f34109e33dcb7d1d4106ecb5389fdc414e2b'}.items():
    actual = subprocess.check_output(['git', 'rev-parse', tree + ':' + name], text=True).strip()
    assert actual == expected, (name, actual, expected)
print('Verified reviewed source subtrees:', tree)
