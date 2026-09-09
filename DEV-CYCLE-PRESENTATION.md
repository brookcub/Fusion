# Windows verification launch repair

Windows Node could not directly spawn the global `pnpm.cmd` shim, producing
`spawnSync pnpm ENOENT` before artifact bootstrap or `verify:fast` could run.
The repair resolves the installed pnpm JavaScript entrypoint and runs it through
Node with the original argv array. No command shell receives package names,
paths, spaces, or metacharacters.

Private focused evidence: the artifact/bootstrap, resolver, and watchdog tests
passed 56/56; a real `pnpm --version` invocation returned `10.33.0`. The test
fixtures now normalize Windows paths before asserting missing/stale artifacts.
This is a Workspace candidate only; it has not been released or deployed.
