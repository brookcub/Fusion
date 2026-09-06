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

The periodic self-healing sweep must obey the same invariant for both AI-merge
and verification checkouts. It also uses the asynchronous runner now, retaining
its distinct age/liveness/audit policy. Two held-removal regressions cover those
prefixes. An HTTP timeout alone is not proof of event-loop starvation: no matching
maintenance-sweep marker was found in the later pilot failure. Keep that failure
distinct from the independently reproduced synchronous-cleanup defect.

Merge failures now emit content-free stage/category/source-coordinate evidence
before awaited cleanup begins. This preserves the original failure boundary when
cleanup is slow; it does not skip cleanup, replace the original exception, or
print error prose. The held-cleanup test exercises the real merge owner and
requires the diagnostic before cleanup resolves. See `merge-failure-evidence.ts`.
