# BUILD-BASELINE — Windows build + test baseline for the LynCo fork of Fusion

**Date:** 2026-09-02 · **Ref:** tag `v0.76.0` = commit `8b00bab0b0b345d12f4bb5955c27523666d6ea54` (branch `pinned-v0.76.0`) — matches the live Task System's pinned npm install (`@runfusion/fusion@0.76.0`).
**Machine:** Windows 11 Pro 10.0.26200, repo at `C:\LynCo Workspace\fusion-fork\` (note: the path contains a space — relevant to one finding below).
**Remotes:** `origin` = https://github.com/brookcub/Fusion (the fork; push allowed). `upstream` = https://github.com/Runfusion/Fusion **fetch-only** (push URL set to `DISABLED`).

## Toolchain

| Tool | Version | Notes |
|---|---|---|
| node | v24.14.0 | repo requires `>=22.4.0` |
| pnpm | 10.33.0 | via corepack shims (`corepack enable --install-directory ~/.corepack-bin`); the repo's `packageManager` pin selects 10.33.0 **when run from the repo root** — outside it corepack picks its own default (11.x), so always run pnpm from the repo |
| git | clone with `core.autocrlf=true` (machine default) — text files are CRLF in the working tree |

## Commands that work (verified this run, in order)

```bash
cd "C:/LynCo Workspace/fusion-fork"
pnpm install --frozen-lockfile   # 4m07s. Green. "Ignored build scripts: @swc/core, agent-browser, better-sqlite3" is the repo's documented, reviewed policy (see docs/contributing.md) — do not approve-builds.
pnpm build                        # ~35-40m first run (vite dashboard build dominates; content-hash cache makes rebuilds much faster). Exit 0.
node scripts/run-static-gate-checks.mjs   # static gate battery. Exit 0.
pnpm --filter @fusion/core test:unit-gate                 # PASS 4 files / 184 tests (~22s)
FUSION_PG_TEST_URL_BASE="postgresql://postgres@127.0.0.1:15432" \
  pnpm --filter @fusion/core test:pg-gate                 # PASS 2 files / 10 tests (~63s) — needs a reachable PostgreSQL, see below
pnpm --filter @runfusion/fusion test:ci-shape             # PASS 1 file / 72 tests (~1.4s)
pnpm --filter @fusion/engine test:core                    # see "Engine core gate" below
```

`pnpm test:gate` (the root merge-gate script) was NOT run as-is: its second stage is a
`sh -c '...'` parallel-run one-liner written for a POSIX shell; the components above are that
gate run individually. Static checks + unit-gate + pg-gate + ci-shape + engine core = the same
battery.

## Baseline results

| Gate component | Result |
|---|---|
| `run-static-gate-checks.mjs` (13 checks) | PASS (exit 0) |
| `@fusion/core test:unit-gate` | **PASS** 184/184 |
| `@fusion/core test:pg-gate` | **PASS** 10/10 (with PG reachable; **silently SKIPS 10/10** without one — see quirk 2) |
| `@runfusion/fusion test:ci-shape` | **PASS** 72/72 |
| `@fusion/engine test:core` | **FAILS at startup on Windows, unpatched** (quirk 1); see below for the one-line workaround result |

## Windows quirks (the honest baseline)

1. **Engine core gate startup failure (blocker, one line).** `pnpm --filter @fusion/engine test:core`
   dies before running any test: vitest's SSR transform of the globalSetup script
   `scripts/build-engine-core-gate-bundle.mjs` hits `RollupError: Parse failure: Expected ident`
   at the file's `#!/usr/bin/env node` shebang (import hoisting places it mid-file; the rollup
   parse then rejects it). Observed under node 24.14.0 / vitest 4.1.10 / rollup 4.60.0 on
   win32; the error's `/@fs/C:/LynCo%20Workspace/...` frames show the space-in-path fs fallback
   is in play, and the CRLF working tree is another candidate difference vs upstream's
   macOS/Linux dev machines. Root cause not fully attributed. **Workaround verified:** deleting
   the shebang line (the script still runs fine as a globalSetup module and via `node`) lets the
   gate proceed. Result with that one-line local edit is recorded in the table below; the edit
   was reverted afterward — the pinned tree is byte-identical to `v0.76.0`.
2. **pg-gate skips silently without a PostgreSQL server.** `pgDescribe` probes
   `FUSION_PG_TEST_URL_BASE` (default `postgresql://localhost:5432`) via TCP and converts the
   whole suite to `describe.skip` when unreachable — "2 skipped (2) / 10 skipped (10)" LOOKS
   green. For a real gate, stand up a throwaway server from the repo's own embedded binaries
   (no install needed):
   ```bash
   PGBIN="node_modules/.pnpm/@embedded-postgres+windows-x64@15.18.0-beta.17/node_modules/@embedded-postgres/windows-x64/native/bin"
   "$PGBIN/initdb.exe" -D <scratch-dir> -U postgres -A trust -E UTF8
   "$PGBIN/postgres.exe" -D <scratch-dir> -p 15432 -c listen_addresses=127.0.0.1
   FUSION_PG_TEST_URL_BASE="postgresql://postgres@127.0.0.1:15432" pnpm --filter @fusion/core test:pg-gate
   ```
   (10/10 passed this way on this machine.)
3. **The build dirties the working tree with EOL-only churn.** `pnpm build`'s skill-sync step
   rewrites `packages/cli/skill/fusion/SKILL.md` + 2 reference files; on a CRLF checkout the
   only delta is line endings (`git diff --ignore-cr-at-eol` is empty). Restore with
   `git checkout -- packages/cli/skill/fusion/` before committing anything.
4. **CLI fast package mode.** `pnpm build` builds the CLI in "fast package mode" (skips desktop
   ensure-build, bundled-plugin staging, full plugin-sdk DTS). Release packaging needs
   `pnpm build:full` or `FUSION_CLI_FULL_PACKAGE=1` — not exercised this run.
5. **Existing test suites with POSIX assumptions** (candidates for Windows failures in the FULL
   suites, not part of the gate battery): `packages/core/src/__tests__/postgres/pg-backup.test.ts`
   writes `#!/bin/bash` fake pg_dump scripts and invokes them directly. The full per-package
   suites (`pnpm --filter @fusion/engine test`, `@fusion/core test`, dashboard lanes) were NOT
   run this session — this baseline covers the merge-gate battery only.

## Engine core gate — result with the shebang workaround

With the one-line shebang removal (reverted after measuring), the engine-core gate runs:

```
Test Files  1 failed | 20 passed (21)
     Tests  1 failed | 431 passed (432)
```

The single failure is a pure Windows path-separator expectation, not a product bug:
`src/__tests__/scheduler-workflow-cutover.test.ts:373` — "passes worktree naming and directory
settings to the workflow release allocator" expects the literal string
`/tmp/project/custom-worktrees/fn-102` and receives `C:\tmp\project\custom-worktrees\fn-102`
(node `path.join` on win32). **Windows engine-core baseline: 431/432, with both deltas
(the shebang startup blocker and this path assertion) being upstream-fix candidates in their
own right.**
