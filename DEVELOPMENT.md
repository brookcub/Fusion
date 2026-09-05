# Local Fusion development

This is the customized Fusion source, not the live installation. Develop in a
`codex/...` worktree; keep the original task-execution checkout and its existing
Fusion task branches intact. `main` is the reviewed local integration line.
The preserved upstream snapshot branch is not silently merged into it.

## Fix and test

```powershell
git worktree add -b codex/my-fix '<new Workspace worktree>' main
corepack pnpm install --frozen-lockfile
# Run the regression relevant to the change; for the startup visibility fix:
corepack pnpm --filter @fusion/core exec vitest run src/__tests__/task-list-startup-visibility.test.ts
# Broader core unit gate:
corepack pnpm --filter @fusion/core test:unit-gate
# Cached development build (not a distributable package):
corepack pnpm build
```

Commit separate bug fixes with their regression tests and changesets. Do not
mix a large upstream synchronization into an urgent local patch. For a clean
upstream PR, branch from the deliberately selected upstream base and cherry-pick
only the relevant fix. `upstream` stays fetch-only; publishing a branch/PR is an
explicit action, never a side effect of preparing a local release.

## Prepare and deploy

Task System owns the packaging/deployment workflow and its public lifecycle
entrypoint. Read its `RELEASE-WORKFLOW.md`; executing instance configuration is
the authority for installed release and runtime paths. Do not launch a dev
daemon against a real execution repository or reuse production HOME, database,
plugins, mirror destination, provider stores, or ports.

The loop is: focused tests → reviewed commit on local main → prepare immutable
package while the old board keeps running → isolated paused rehearsal → explicit
Task System deploy. Same-commit preparation is cached; build/install never run
inside the cutover. No `npm publish`, release tag, or upstream push is involved.

First adoption of the fork into the current stock live installation remains a
separate paused-only promotion. A green isolated fixture is not live adoption.

## Current focused regressions

```powershell
corepack pnpm --filter @fusion/dashboard exec vitest run src/__tests__/deployment-maintenance.test.ts
node --import tsx --test packages/desktop/scripts/workspace-tools.test.ts
node scripts/check-changeset-format.mjs
```

Engine/PostgreSQL integration suites must report actual executed tests. A skipped
PG suite is not a passing database gate. Known baseline harness limitations are
recorded in `BUILD-BASELINE.md`; do not hide them by increasing timeouts or
weakening assertions. The Task System packaged rehearsal is separate evidence.
