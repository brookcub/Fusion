---
"@runfusion/fusion": patch
---

summary: Bind successful build certification to the source identity that was actually admitted to compilation.
category: fix
dev: Reuse the planner's pre-build source hash instead of certifying source that may have changed after compiler consumption.
