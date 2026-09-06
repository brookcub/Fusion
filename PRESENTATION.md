# FUSI-006: preserve work while pausing

## Why this change

The long-lived executor used two pause exit paths that moved work backward. The
throwing path also deleted the assigned checkout and cleared its binding. Keeping
step counters did not preserve uncommitted implementation work. Both paths now use
the existing in-place recovery owner, retaining lane, branch, checkout, and steps.
Explicit unpause can redispatch only after the old executor releases its lock and
the current task and project pause authorities permit execution.

Native Git on this Windows host also followed directory junctions during worktree
removal, deleting external synthetic dependency/source files in a real regression.
Native removal now inspects without following links. Only positively ignored,
untracked, regenerable artifact links in a clean, unlocked, registered secondary
checkout may be detached. Unknown state, dirty work, root links, and indexed
descendants refuse cleanup. Git retains its normal no-force deletion checks.

## Validation and limits

All commands below run from `packages/engine` in this isolated Workspace checkout.
No test uses production task data, credentials, database, or mirror.

- `pnpm exec vitest run --project engine-default src/__tests__/executor-aborted-step-session-recovery.test.ts --reporter=dot`
  captured a genuine red baseline: 8 failures, 24 passes. Each new single-session
  case observed `todo` instead of its original `renamed-wip` lane.
- The repaired pause file plus `executor-user-cancel-terminal-graph-exit.test.ts`
  passed 41 tests. The new cases also assert no worktree-removal call and exactly
  one lock-released resume only when neither pause authority applies.
- The native `worktree-junction-preservation.real-git.test.ts` first failed because
  its external dependency sentinel was deleted. After repair, its seven native
  cases plus four `windows-worktree-removal.test.ts` uncertainty cases passed:
  11 tests, no skips on Windows. Includes a clean-status case-variant indexed
  descendant, dirty checkout, locked checkout, and root-junction refusals.
- Six changed legacy pause cases in `executor-prompt.test.ts` passed using `-t`
  selection (109 other cases explicitly unselected). This is not a full-suite pass.
- `pnpm exec tsc --noEmit` passed after the review corrections. Repository-root
  `pnpm check:changesets` and `git diff --check` passed.
- The combined eight-file, 184-test pause/removal/ownership run passed 183 tests;
  one existing defensive-removal fixture teardown hit Windows `EBUSY`. Its prior
  run passed; a serialized full-file rerun failed identically (35 passed, one
  teardown failure). The orphan path does not invoke the changed native cleanup:
  its unchanged ownership probe can return after one parallel Git probe fails
  while the sibling probe still holds the fixture directory. No timeout/retry or
  assertion was weakened to hide this. The single case passed on clean baseline.
- The full legacy prompt file remains red: nine failures independently reproduced
  on clean baseline f7341e88, plus one order-sensitive rate-limit observability
  failure in the candidate's full-file run. That observability case passes alone
  on both baseline and candidate. These results are not represented as green.

Cold review found and closed two narrow Windows admission errors: inaccessible
root state must not mean absence, and indexed paths must compare case-insensitively.
The reviewer then returned scoped PASS on the corrections and pause ownership.

## Adoption

Package this reviewed commit before cutover. Task System's public deployment owns
fresh backup, maintenance fencing, rollback, paused startup, and no-motion checks.
Production is not changed merely by this presentation or successful unit tests.
Then recover FUSI-013 from the preserved branch and exact source artifacts, run its
real PostgreSQL/HTTP regression, and finish normal workflow review and local landing.
Do not enable any other backlog task or publish upstream under this scope.
