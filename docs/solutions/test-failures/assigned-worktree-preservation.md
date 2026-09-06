# Preserve an unfinished task's assigned checkout

The live FUSI-005 continuation exposed a checkout-lifetime failure. Its random-name
legacy checkout disappeared and the task pointed at an absent task-ID checkout.
The implementation remained recoverable in its branch and immutable recovery refs;
the pilot did not complete. Metadata-only diagnostics observed missing-file failures,
not enough evidence to identify the exact deletion actor.

The acquisition code rejected a registered legacy path solely because its basename
was not the task ID, then wrote its proposed replacement before creating it. That
removed the original assignment's protection from idle-worktree collection.

The repair accepts existing, registered, branch-matched legacy checkouts within the
managed roots. Replacement ownership is recorded only after successful acquisition.
Conflict cleanup also refuses an unfinished task's assigned checkout during session
gaps; its caller must honor that refusal before pruning, branch deletion, or clearing
the assignment. Completed tasks retain their existing cleanup path.

## Validation

`legacy-worktree-acquisition-preservation.test.ts` uses native Git repositories whose
paths contain spaces. It proves original registration, branch identity, modified
tracked bytes, untracked bytes, and idle-sweep exclusion after resume, preparation
failure, conflict-cleanup refusal, and caller refusal. The original acquisition and
caller behavior produced genuine failing regressions before the corresponding fixes.

The focused native and pinned-acquisition tests passed 14/14. Engine typecheck and
production-file ESLint passed. A cold focused diff review closed the caller finding
and reported no remaining material blocker; it did not independently rerun tests.
The broader `executor-worktree-conflict.test.ts` attempt was **20 passed / 2 failed**
across its combined run: two obsolete fixture tests reference an undefined
`mockedGenerateWorktreeName` before reaching the changed action. That run is not green.

The final public `pnpm test:gate` passed: 16 static validators, 461 engine tests,
177 core unit tests, 10 isolated PostgreSQL tests with zero skips and verified
shutdown, and 72 CLI tests. The public merge gate retains the explicit lifecycle-scanner quarantine described in
[Windows merge gate portability](windows-merge-gate-portability.md). Passing that gate
does not claim the quarantined scanner passed, or prove this repair is deployed.
Deployment and live pilot outcomes belong to the Task System operational receipts.
