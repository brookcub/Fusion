---
"@runfusion/fusion": patch
---

summary: Isolate concurrent Claude CLI system-prompt files.
category: fix
dev: Bind each real prompt file to its owning child and clean failed or settled launches without deleting another session's prompt.
