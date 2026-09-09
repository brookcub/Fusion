# Late cancellation recovery repair

The concurrent pilot exposed a real defect after a long verification command:
late cleanup cleared runtime abort markers before the old implementation ended.
The resulting cancellation was treated as a transient provider failure, clearing
the task's branch/worktree binding and moving it to intake despite its pause.
The project pause prevented a fresh dispatch; the actual Git work survived.

The repair reads current task/project pause authority, retains the implementation's
original abort signal even after map replacement, and fences delayed cleanup by
run identity. It never releases an unsettled predecessor's ownership. An incomplete
cleanup becomes an explicit paused failure rather than a forced overlapping run.
Checkout, branch, lane, and completed steps are retained. This is simpler because
the old execution remains the sole owner of its cleanup and final release.

Validation in this isolated Workspace worktree:

- Red baseline: 3 cleanup-boundary regressions and 4 real implementation-runner
  pause regressions failed against the prior code.
- `pnpm --filter @fusion/engine exec vitest run src/__tests__/executor-aborted-step-session-recovery.test.ts src/__tests__/executor-stuck-requeue-preserve-progress.test.ts --reporter=dot`:
  50 passed, no skips, exit 0. Includes task/user/global/engine pause, late pause,
  replaced controller map, replaced execution owner, failed cleanup, unavailable
  authority, and preservation of normal continuation behavior.
- `node scripts/run-merge-gate.mjs`: 720 passed, no skips, exit 0; private PostgreSQL
  gate shutdown verified. Sixteen static validators passed.
- `pnpm --filter @fusion/engine exec tsc --noEmit`: exit 0.
- Independent read-only diff review: PASS for this incident's repair.

PowerShell invoked pnpm via its explicit Node/Corepack entrypoint. No live task
database was used for these tests. Package/lifecycle evidence belongs to Task
System's deployment receipt, not this source-level validation note. This repair
does not claim the three pilot tickets complete or general transient recovery fixed.
