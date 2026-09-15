---
"@runfusion/fusion": patch
---

summary: Announce implementation completion only after required task state is durable.
category: fix
dev: Preserve the first accepted completion payload and move the graph handoff after required step/task writes without making optional diagnostics a new veto.
