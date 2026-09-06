# Authorized repair scope

Owner approval: "yes you can fix both" following the request to repair FUSI-006,
test it in isolation, deploy it paused, and retry FUSI-013.

This branch repairs pause/abort worktree preservation and safe native worktree
removal around Windows junctions. Use actual executor-entry regressions and native
Git fixtures. Preserve user cancellation semantics, live ownership, terminal
states, and fail-closed pause behavior. No backlog release, unrelated cleanup,
upstream publishing, or direct live database mutation. FUSI-010 remains a next
priority, not a task to dispatch under this scope.

FUSI-013 recovered source artifacts remain in the separate recovery-operations
incident folder. Do not run its historical runner versions or Git-remove any
existing junction-linked baseline. Reviewed code is packaged ahead of a public
Task System paused deployment with a fresh verified backup and rollback contract.
