---
"@runfusion/fusion": patch
---

summary: Preserve paused work and predecessor ownership when session cleanup finishes late.
category: fix
dev: Fence stuck cleanup by run identity and retain the original cancellation signal during implementation recovery.
