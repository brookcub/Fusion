---
"@runfusion/fusion": patch
---

summary: Add an API route to append task activity log notes.
category: fix
dev: Adds POST /api/tasks/:id/log in the dashboard task-route registrar and reuses TaskStore.logEntry.
