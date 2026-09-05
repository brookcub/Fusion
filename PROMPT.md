# Task: reproducible local fixes and paused release preparation

Owner emphasis: "and deployment needs to be quick so we can patch problems and deploy fast"

The deliverable is an isolated development and prepared-release workflow. Live
automation, task execution, upstream publication and first fork promotion are
not part of this implementation. Task System owns daemon lifecycle and recovery.

## Symptom verification: task-list visibility

An include-deleted forensic list and the ordinary board list could share the
same startup memo entry. Reproduce both query orders against `listTasksImpl`,
not a duplicate implementation. The key must include archived policy, deleted
policy, and column independently; memo hits must remain cloned and expire.

## Surface enumeration

The changed cache is the real startup slim-list path in core task-store reads.
Tests cover both deleted-policy orders, false/undefined equivalence, archive and
column combinations, store isolation, cloning and expiration. Paginated readers
bypass that memo. The separate Windows packaging correction runs actual tsc,
Vite and Vitest entrypoints from a spaced checkout, and refuses unknown tools.

Maintenance fencing is independently opt-in: ordinary HTTP and authenticated
WebSocket upgrades are refused until the Task System transaction reopens the
board. The controller capability remains process-only; ordinary daemon-token
authorization is still required for authenticated APIs.
