---
"@fusion/engine": patch
---

summary: Enforce pauses and truthful workflow verification across execution boundaries.
category: fix
dev: Recheck task and project pauses at direct dispatch, graph node entry, and workflow
lifecycle transitions. Treat workflow-owned review moves as internal transitions
so their lifecycle listener does not abort its own graph. Report verification
command exit truth separately from expected-failure assertions on both native and
sandbox execution paths.
