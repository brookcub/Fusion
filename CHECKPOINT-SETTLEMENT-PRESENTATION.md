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
checkpoint field except `status`; completed rows are idempotent no-ops. Duplicate,
wrong-pin, worktree-marked, non-terminal, read/write failure, changed projection,
and abort states fail closed.

## Validation

Focused command: `pnpm --filter @fusion/engine exec vitest run
src/__tests__/workflow-graph-foreach.test.ts --reporter=dot`.

Focused production-wiring + checkpoint suites passed 59 tests (one unrelated
skip) in 16.51 seconds; engine typecheck passed. No PostgreSQL, models,
artifacts, or live task state are used.
