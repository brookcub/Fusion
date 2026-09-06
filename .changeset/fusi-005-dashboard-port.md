---
"@runfusion/fusion": patch
---

summary: Honor the configured dashboard listen port when --port is omitted.
category: fix
dev: Dashboard CLI startup resolves --port/-p, then global daemonPort, then 4040.
