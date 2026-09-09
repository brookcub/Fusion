# Windows verification launch and containment repair

Windows Node could not directly spawn the global `pnpm.cmd` shim, producing
`spawnSync pnpm ENOENT` before artifact bootstrap or `verify:fast` could run.
The repair resolves the installed pnpm JavaScript entrypoint and runs it through
Node with the original argv array. No command shell receives package names,
paths, spaces, or metacharacters.

The shared watchdog now resolves pnpm centrally (including `test-changed`) and,
on Windows, starts its exact Base64 JSON argv under a suspended-child,
kill-on-close native Job. The Job itself owns the deadline and proves emptiness
before returning; cancellation terminates the Job-owning helper rather than
relying on an unsupported negative-PID process-group signal.

Private focused evidence: resolver/artifact/watchdog tests are green, a real
`pnpm --version` invocation returned `10.33.0`, and real Windows regressions
prove literal space/ampersand argv plus cleanup of a detached child-grandchild
tree after both timeout and explicit parent cancellation. The test fixtures now
normalize Windows paths before asserting missing/stale artifacts. This is a
Workspace candidate only; it has not been released or deployed.
