---
"@runfusion/fusion": patch
---

summary: Keep terminal foreach step-instance state monotonic under delayed same-run writers.
category: fix
dev: Fence the existing PostgreSQL upsert atomically so stale nonterminal writers cannot overwrite completed or failed workflow-run step instances while terminal writes remain allowed.
