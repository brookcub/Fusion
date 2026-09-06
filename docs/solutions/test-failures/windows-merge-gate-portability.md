---
category: test-failures
module: merge-gate
tags: [windows, process-lifecycle, quarantine]
problem_type: shell-portability
applies_when: Running the public merge gate from a Windows source checkout.
---

# Windows merge gate: portable launcher and observed scanner quarantine

The public gate used single-quoted POSIX background/wait syntax through Windows
cmd. A real merge attempt failed with unrecognized `engine_pid`, `pg_pid`,
`unit_pid`, and `status` commands. The Node launcher now passes argument arrays,
waits for all lanes, and refuses CI-shape after any failure. PostgreSQL owns a new
temporary database; success requires executed tests plus process/endpoint absence.

## Measured evidence (2026-09-05/06)

From the spaced `Fusion Upstream Recovery` checkout based on `ec2b42a`:

- First `pnpm test:gate`: exit 0; 16 static validators, engine 461, core unit 203,
  PostgreSQL 10 with no skips, CLI shape 72. Engine 71.26s, core 57.51s.
- Next public run with stricter PG cleanup: exit 1. Engine 461 passed and PG 10
  passed with shutdown verified. Core 202 passed, one failed:
  `no-hardcoded-lifecycle-columns.test.ts` / lifecycle-column literal ratchet (AST)
  / does not increase the number of `triage` column guards exceeded 15000ms.
  Core lane 61.27s. CI-shape correctly did not run. This is not green evidence.
- A conservative candidate prefilter experiment preserved the full ordered Site
  tuples (SHA-256 `6cae05d13ecbc0dafeadac27a4a086112550031b01206ec808aedc8ef72d279c`)
  but increased parse candidates and failed two 15s checks in a 95.49s isolated run.
  The experiment was reverted in full; it is not part of the repair.
- Final `pnpm test:gate`: exit 0; 16 static validators, engine 461 (50.69s),
  core unit 177 (24.37s), PostgreSQL 10 with no skips and verified shutdown,
  CLI shape 72 (0.778s). Focused launcher/policy regressions: 26 passed.
  Changed scripts/config ESLint and quarantine ledger lockstep check exited 0.

The unchanged scanner is quarantined under the repository's on-sight rule, with
matching ledger/config and removal from the blocking selector. Its assertions,
ceilings, timeout, and source remain unchanged. This deliberately removes 26 tests
from the blocking gate; it is not a claim that those tests passed. Rescue requires
a measured root-cause performance correction, not retries or a larger timeout.

Launcher regressions separately prove static refusal, sibling settlement after
throw/rejection/nonzero/spawn failure, final-lane ordering, spaced argv, skipped-PG
refusal, swallowed shutdown errors, and surviving PID/listener refusal. The focused
review caught the swallowed-stop problem before integration; it was corrected.
