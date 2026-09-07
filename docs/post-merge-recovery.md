# Recover interrupted post-merge verification

A card can already be merged when an interruption prevents its final verification.
Ordinary Retry intentionally rejects completed cards. Do not move such a card
backward or reset its implementation to obtain a missing final review.

The authenticated, project-scoped API provides:

```http
POST /api/tasks/:id/retry-post-merge?projectId=<project-id>
Content-Type: application/json

{"expectedCommitSha":"<exact 40-character landed commit>"}
```

The response is acceptance, not completion: `started`/`already-running` returns
202, and `already-complete` returns 200. Inspect the task's durable post-merge
result and the project's settled runtime before declaring success. A failed or
missing result is not a pass even though the already-landed card remains done.
Identify the new attempt by its `startedAt`; an asynchronous acceptance does not
turn the prior attempt's restart-failure notice into the new attempt's result.

Recovery supports only the unchanged built-in coding workflow. It requires
confirmed landing, completed implementation and prior enabled gates, explicit
post-merge enablement, no competing execution, and an unpaused task/project.
It uses the ordinary graph, provider/principal admission and cancellation paths,
but enters only the read-only verification tail. It cannot restart implementation
or fall back to a different workflow. Identity and workflow-selection fences
prevent an overtaken run from publishing verification for changed work.
Recovery enforces read-only tools at the session boundary even when the workflow's
ordinary reviewers permit inline fixes. It grants neither repair instructions nor
delegated coding tools.

Use the installation's owning lifecycle/automation interface for pause, resume,
startup and shutdown. In Task System deployments this remains `task-system.ps1`.
Pause unrelated queued work before temporarily resuming the recovery project.
Fusion defers its restart recovery while paused. Allow normal unpause recovery to
retire abandoned ownership before requesting the verification tail; never clear
those rows directly to force admission.
Never store another bearer-token copy to invoke this operation.

Run `node scripts/run-post-merge-recovery-regression.mjs` for the private
PostgreSQL, graph and mounted HTTP regressions. Its temporary evidence directory
is retained and a green result requires actual tests with zero skips and verified
owned-database shutdown. A private real-runtime interruption/recovery rehearsal
is additional integration evidence, not replaced by the HTTP mock fixture.
