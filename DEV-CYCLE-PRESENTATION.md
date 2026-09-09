# Windows verification launch and containment repair

Windows Node could not directly spawn the global `pnpm.cmd` shim, producing
`spawnSync pnpm ENOENT` before artifact bootstrap or `verify:fast` could run.
The repair resolves the installed pnpm JavaScript entrypoint and runs it through
Node with the original argv array. No command shell receives package names,
paths, spaces, or metacharacters.

The shared watchdog now resolves pnpm centrally (including `test-changed`) and,
on Windows, starts its exact Base64 JSON argv under a suspended-child,
kill-on-close native Job. The Job itself owns the deadline and proves emptiness
before returning. Cancellation is an owned sentinel observed by that helper,
which terminates and proves its Job empty before returning a cancellation
receipt; it does not rely on an unsupported negative-PID process-group signal.
The helper emits a content-free completion receipt (`exit`, `timeout`, or
`cancelled`, plus Job-empty proof), which the wrapper validates before returning
so ordinary child codes 124/125 cannot be misclassified and missing or failed
helper receipts fail loudly.

Private focused evidence: resolver/artifact/watchdog tests are green, a real
`pnpm --version` invocation returned `10.33.0`, and real Windows regressions
prove literal space/ampersand argv plus cleanup of a detached child-grandchild
tree after both timeout and explicit parent cancellation; the cancellation
regression also passed three consecutive real runs. The test fixtures now
normalize Windows paths before asserting missing/stale artifacts. This is a
Workspace candidate only; it has not been released or deployed.
# Parent adversarial review follow-up

Native helper setup/cancellation deadlines now remove invocation listeners and
timers before refusing. A stuck helper is terminated best-effort, but the result
is explicitly **cleanup unproven**, never successful cancellation or timeout
completion. Proven outcomes still require the native Job-empty receipt. Ordinary
command exits 124/125 remain ordinary failures. The legacy helper invocation
without receipt arguments remains supported.

Parent validation: the three-file isolated suite passed 67 tests in 5.890 seconds,
including real Windows descendant/listener absence and adversarial fake-helper
startup, cancellation, and malformed-outcome cases. The subsequently added pnpm
discovery failure tests passed 4/4 in 0.014 seconds. A prior automatic-permission
review timed out before launching; that invocation produced no test result.
The default isolated subprocess invocation separately refused with EPERM; the
pure resolver tests passed using Node's no-subprocess test isolation mode.

Final scoped suite after pnpm discovery validation: 68/68 passed in 5.446 seconds.
ESLint passed for all seven changed JavaScript source/test files, using the
existing development installation and a SHA-256-identical ESLint configuration
without installing a second dependency tree. This is scoped lint, not the full
repository suite. No live installation or Fusion-owned task worktree was modified
by these tests. Final cold review remains pending.
