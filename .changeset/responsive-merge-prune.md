---
"@runfusion/fusion": patch
---

summary: Keep health and pause requests responsive while removing stale merge worktrees.
category: fix
dev: Pre-merge filesystem fallback uses asynchronous removal within the existing bounded retry and ownership guards.
