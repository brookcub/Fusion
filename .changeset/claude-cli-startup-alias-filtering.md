---
"@runfusion/fusion": patch
---

summary: Exclude stale native Claude aliases before dashboard and server extension startup.
category: fix
dev: Apply the existing bundled-provider path and registration safeguards to dashboard, serve, and daemon startup, before engine sessions are created.
