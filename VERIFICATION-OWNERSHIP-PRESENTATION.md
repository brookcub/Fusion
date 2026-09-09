# Bounded verification ownership

## Why this repair

The concurrent pilot exposed three different problems: a legitimate semaphore
wait was invisible, task-tool cancellation dropped its signal, and Windows
shell termination could leave child processes and inherited pipes alive.
An output callback could also throw from the heartbeat timer. These are product
and test-loop defects, not evidence that implementation work should be repeated.

The repair gives each verification attempt one current-process queue receipt,
an independently bounded admission wait, and its existing command budget. Health
exposes project-filtered owners with explicitly process-wide counts. Restart
creates a new process identity rather than reconstructing live ownership from
historical logs. Slot completion is not a successful verification verdict.

On Windows, the runtime and developer test runner now share one bundled native
Job helper source. It assigns a suspended child before execution, owns detached
descendants, and proves the Job empty before issuing a valid completion receipt.
Node performs shell quoting inside that Job. Timeout, cancellation, ordinary
exit 124/125, and cleanup uncertainty remain distinct. Failed evidence is retained;
no command, environment or credential is written into the content-free IPC files.
The generated helper file contains only the packaged program source.

Task-tool signals reach admission and the command backend. Activity observers
cannot prevent execution, throw from the quiet timer, or delay cleanup. The
existing verification cap, exit-truth semantics and command budgets remain.

## Actual validation

All commands ran in this isolated Workspace checkout; no live tasks, database,
providers or canonical mirror were used.

- Shared developer watchdog: `node --test scripts/__tests__/run-vitest-watchdog.test.mjs`
  — 25 passed, 5.585 seconds; the decoded relocated helper hash matched its source.
  After adding a pre-launch cancellation check to the shared source: 26 passed,
  6.341 seconds. The source itself is authoritative; the redundant embedded hash
  field was removed rather than maintained as a second copy of a derived fact.
- Engine Vitest: `src/sandbox/__tests__/windows-owned-command.test.ts`,
  `src/sandbox/__tests__/native.test.ts`, `src/__tests__/verification-tool-admission.test.ts`,
  `src/__tests__/verification-concurrency.test.ts`, `src/__tests__/verification-wrapper-queue.test.ts`
  — 41 passed, two existing POSIX-only skips, 17.84 seconds.
  The Windows cases proved parent/child PID absence and listener absence after
  cancellation and normal completion, separate deadline classification, ordinary
  exits 0/7/124/125, space/quote handling and bounded output.
  Final native containment + hostile-receipt rerun: 18 passed, 9.90 seconds.
- Existing verification commands, sandbox exit truth, native streaming and
  hostile helper-receipt tests — 68 passed, 15 existing platform skips, 24.75 seconds.
- Added observer correction: sandbox exit-truth file — 9 passed, 9.67 seconds,
  independently rerun by Terra after its review found the unguarded callback.
- Read-only project health: two tests passed in the independent review.
- Engine source `tsc --noEmit`: exit 0. Repository configuration excludes most
  test files from this typecheck; they are not claimed typechecked or linted.
- Scoped ESLint on nine changed production TypeScript files: exit 0.
- `pnpm check:changesets`: exit 0.

The first full merge gate was red: 16 static validators and 177 core tests passed,
but the engine gate had 401 passes and 60 failures in two merger fixture files.
Those files simulated shell execution rather than the new native Job boundary.
Their existing merge assertions are retained while the fake command adapter is
updated. This red result is preserved as `queue-gate-red.json` in the pilot
operations evidence; it is not a green gate or a reason to weaken verification.

The initial new native parent fixture had a syntax error (missing closing brace);
those two failures did not exercise descendant containment. A compile check was
added before fixture launch, the syntax corrected, and the real assertions passed.
The earlier shell-only cancellation reproduction really leaked two processes;
their exact identity was recovered and both were stopped before this repair.

## Faster feedback, same checks

The queue-wrapper regression imports the narrow verification module, not the
entire executor. Its measured focused wall time is 5.164 seconds; all four prior
sandbox-wiring cases are unchanged and independently passed in 12.140 seconds.
No timeout was widened, check weakened, provider substituted or substantive ticket
replayed to obtain these results.

## Review and deployment boundary

Terra's focused source review passed after the observer correction. The separate
checkpoint settlement candidate closes only exact obsolete in-progress rows
behind already-terminal steps, preserving existing failed/completed history.
These candidates still require integrated gates, immutable packaging and private
lifecycle verification before the public Task System deployment path is used.
The live pilot remains paused; this document is not a claim of deployment or DONE.

## Integrated acceptance

At source integration `0d12f9aec3ae5976d7d8dcdd7b36e427d2216f5d`, the complete
`pnpm test:gate` passed: 16 static validators, 177 core tests, 461 engine tests,
72 CLI tests and 10 isolated PostgreSQL gate tests (720 tests total). The private
PostgreSQL shutdown was verified. The repaired merger fixtures retain the prior
command-dependent success/failure/abort behavior at an explicit fake backend;
they do not manufacture native Job receipts. No gate assertion was removed.

Integrated checkpoint + queue + admission + observer + wrapper regressions:
102 passed, one pre-existing unrelated skip, 26.96 seconds. Final Terra review
of native deltas: PASS, 29 native/failure/mapping tests passed in 16.9 seconds,
with source lint and engine typecheck exit 0. The actual live public status was
refreshed after testing: running/ready, both configured projects desired/actual
paused, no drift. Packaging and private lifecycle rehearsal remain separate
from these source-test results.
