# Fusion architecture audit handoff

This branch is an audit snapshot, not a release candidate. It combines the
integrated repairs with an unfinished reviewer-authority draft. Do not deploy it
or treat the draft as passing validation. No live data or credentials are needed
for this audit.

## Repository and exact comparison points

Repository: https://github.com/brookcub/Fusion

| Ref | Commit | Meaning |
| --- | --- | --- |
| `lab-integration` | `0fcaffeaf48ef21c10dfbf70dbe4b5f90423b40f` | Installed Fusion source baseline; installation is currently stopped after a PC reboot. |
| `codex/verification-queue-visibility` | `851bb61c4ef26940675565cf84488481cfff1f94` | Integrated, tested repairs beyond the installed baseline. Not deployed. |
| `codex/foreach-settings-forwarding` | `507ddc85f18322fb8607f9fd293d0a6ce4aca47e` | Author branch preserving the unfinished reviewer draft. |
| `codex/fusion-architecture-audit-20260910` | This branch | Integrated candidate plus draft and this handoff. Audit target. |

The upstream is https://github.com/Runfusion/Fusion. GitHub fork `main` was
`4f4b8ab846e3ffe73913911f065a7a05ad3a8680` at publication preparation; it is
not the installed baseline and is not changed by this publication. Check out
the named audit branch explicitly, not the repository's default branch.

Useful comparisons:

```sh
git diff lab-integration..codex/verification-queue-visibility
git diff codex/verification-queue-visibility..codex/fusion-architecture-audit-20260910
git log --first-parent --oneline lab-integration
```

## Operating objective: containment, not global vetoes

The operator's current instruction is:

> fusion accidentally using the global setting instead of the project setting shouldn't be a show-stopping blocker. That should be something we observe and fix as the system runs. not something we delay the system running in order to fix

Evaluate our integration and operator/watchdog policies as well as upstream
code. Keep the board/control plane available. Separate service health, task
execution readiness, and policy conformance. Record requested and actual
provider/model/effort with configuration provenance. An explicitly permitted
fallback should be visibly degraded, not silently different. If review authority
cannot be established, contain that review/merge; do not disable the board or
unrelated projects. Preserve completed work and retry the failed stage within
bounded budgets. Reserve service-wide refusal for integrity or containment
failures that genuinely require it.

## Known issues and evidence status

| Area | Current understanding |
| --- | --- |
| Reviewer routing | Installed merger could choose global Spark rather than workflow Claude. Integrated repair resolves workflow policy; actual provider/session route still needs adversarial scrutiny. |
| Settings read failures | Ordinary resolver silently falls back after failed workflow reads. Draft introduces an opt-in strict helper but does not wire it into merger calls. Distinguish absence, failure, and permitted fallback. |
| Approval provenance | Integrated repair binds approvals to reviewer-policy digest and resets approvals on policy change while retaining work. Audit races between policy checks, actual session creation, and landing. |
| Repeated review/source drift | Integrated repair bounds invalidation retries. Audit shared budgets, ownership, restart behavior, and whether failures remain local and actionable. |
| Truthful completion (FUSI-007) | Pilot work exists; selected ticket has not demonstrated verified DONE. Audit verification evidence, merge, final settlement, and false-green exits as one chain. |
| Bounded failure (FUSI-010) | Pilot work exists; no demonstrated verified DONE. Audit retry budgets, interleaved progress/stalls, and terminal versus retryable outcomes. |
| Cancellation/continuations (FUSI-017) | Pilot work exists; no demonstrated verified DONE. Audit stale execution context and cancellation-safe completion/continuation ownership transfer. |
| Activity visibility | Card-derived in-flight counts can imply running work without a real owner. Need authoritative session/process/queue states and useful wait reasons. |
| HTTP responsiveness | Intermittent unresponsiveness was observed under pilot load while database probes stayed reachable. Root cause unresolved; do not label it a database outage without evidence. |
| Windows portability | LF/CRLF source-text assumptions still caused pilot test failure. Audit assertions, argv boundaries, worktree isolation and child ownership. |
| Development latency | Release preparation took roughly 26 minutes in a prior run. Candidate adds incremental plugin builds and removes a duplicate dashboard build; end-to-end improvement is not measured yet. |

The pilot's three committed task branches and their additional local changes
remain local in this publication. They are not represented as completed or
fully included in this audit snapshot. Do not infer their success from a commit
message. The latest recorded pilot reached three in-flight cards, failed its
acceptance check, and was paused afterward; it did not prove three verified
merges. Current stopped state follows reboot, not a newly diagnosed crash.

## Repaired defects worth tracing structurally

The installed lineage contains fixes for scheduler-only pause bypass, workflow
review transitions aborting themselves, expected failures obscuring verification
exit failure, post-merge implementation replay, dropped workflow settings and
shared foreach checkpoints, invisible verification queues, Windows subprocess
quoting/cancellation, Claude CLI authentication/runtime discovery, and test
process shutdown overriding failed exits. Audit the invariants and interactions,
not just whether the local patch has a passing unit test.

Task System owns lifecycle/deployment independently of Lab Runtime. Its source
is a separate local repository without a GitHub remote and is not included here.
Prior repairs cover desired/actual pause state, token-free board receipts,
complete shutdown, cross-instance ownership, caller-process containment, and
stale receipts after reboot. Do not claim to have audited that controller from
this Fusion repository alone. No live deployment or task-operation authority is
granted by this audit handoff.

## Validation already performed, not rerun for publication

On the integrated candidate, `node scripts/run-merge-gate.mjs` exited 0:
16 static validators and 720 tests (engine 461, core 177, PostgreSQL 10 with
zero skipped and verified shutdown, CLI 72). Prior focused reviewer validation
passed 83 merger tests, then one added capped-drift test separately (83 skipped
in that focused run); do not call that a full 84-test rerun. Telemetry validation
passed 61 tests across two files. Engine typecheck and scoped source lint passed.

Those results do NOT validate the draft in this audit branch. The draft adds
`mergeEffectiveSettingsStrict` and `assertReviewSessionPolicyReceipt`, but the
merger still uses the ordinary settings helper. Check missing reconciliation
state, read-error sanitization, custom/builtin definition provenance and
session-policy mismatch tests. It is preserved to avoid losing unfinished work,
not endorsed as the correct final architecture.

## Requested audit output

Prioritize concrete, reproducible structural findings in three lanes:

1. Lifecycle, completion evidence, cancellation and recovery ownership.
2. Configuration precedence, model/provider routing, approval provenance and
   contained degradation.
3. Process isolation, responsive control plane, truthful activity visibility and
   fast deterministic development/verification loops.

For each finding give exact code locations, observed versus inferred evidence,
the violated invariant, smallest reproduction, impact scope, and a minimal
repair. Identify unnecessary global gates to remove as well as missing checks.
Prefer fewer state authorities and idempotent recorded transitions over adding
another reconciliation layer. Prioritize a small repair sequence; do not propose
a blanket rewrite as a substitute for identifying causes.
