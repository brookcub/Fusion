---
title: Pre-merge cleanup must yield to the control plane
applies_when: Health or pause requests time out immediately before an AI merge clean room starts.
---

The retained event immediately before a bounded pilot's API timeout matched the
pre-merge prune's already-de-registered worktree message. Its next operation was
recursive synchronous filesystem removal. Large dependency trees can therefore
block the daemon's event loop even though the enclosing function is async.

`pruneExistingAiMergeWorktrees` now supplies `node:fs/promises.rm` to the existing
`removeDirectoryWithRetry` helper, as post-merge cleanup already does. No path,
age, liveness, retry, audit, or Git-registration authority changes. Completion is
still awaited; this is not detached background cleanup or a longer API timeout.

The responsiveness regression enters the production pre-merge path with removal
held at an asynchronous boundary and proves an event-loop callback runs while
the guarded directory still exists. It failed against the synchronous path.
Existing cleanup tests retain active/new/other-task exclusions, idempotency,
bounded retry, and residual registration checks on the asynchronous runner.
