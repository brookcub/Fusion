# Shared foreach checkpoint settlement

## Scope

This candidate repairs only shared-isolation foreach
resume.  When a step is terminal in the live task projection, an obsolete exact
same-run `in-progress` checkpoint is closed without replaying implementation or
creating review/integration evidence.

## Authority and safety

The ordinary replay projection remains compatibility-tolerant.  A durable write
uses a separate post-load strict store read: missing task/settings, task pause,
or engine/global pause refuse settlement.  The write preserves every original
checkpoint field except `status`; already-terminal completed/failed rows are
idempotent no-ops and retain their original verdicts. Duplicate,
wrong-pin, worktree-marked, non-terminal, read/write failure, changed projection,
and abort states fail closed.

## Validation

Focused command from this checkout: `pnpm --filter @fusion/engine exec vitest run src/__tests__/workflow-graph-task-runner.test.ts src/__tests__/workflow-graph-foreach.test.ts --reporter=dot`.

At f077d9e65, the independent rerun passed 59 tests (one unrelated skip) in
8.74 seconds. The initial restricted launch failed before tests; native
subprocess permission made the same command work without reinstalling packages.
Cold review found the original production refusal fixtures failed at IR validation,
not at the claimed pause boundary. Those old passes do not establish production
wiring. Corrected fixtures include a valid parse-steps dominator and explicitly
resume at foreach, asserting it was actually visited. The corrected success,
missing-settings, and pause-during-task-fetch suite passed 64 tests / one skip
in 20.18 seconds. Engine typecheck passed after the added production tests.

A live read-only census also showed already-failed historical checkpoints for
terminal task steps. A new isolated regression reproduced the candidate's
unintended refusal (one failed, one passed). Such rows are already settled: the
repair preserves them unchanged rather than relabeling them completed. Final
focused validation after this correction: 65 passed / one unrelated skip in
20.96 seconds; engine typecheck exit 0. Scoped lint found one unused catch binding,
which was removed; the final scoped source rerun exited 0. Tests are ignored by this repository's
ESLint configuration and are validated by Vitest and TypeScript, not claimed linted.
No PostgreSQL, models, artifacts, or live task state are used by the focused tests.
