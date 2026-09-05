---
"@runfusion/fusion": patch
---

summary: Block execution dispatch when a workflow-required prompt has no executable steps.
category: fix
dev: Extends the hold-release gate and parse-failure rebound to treat missing PROMPT.md step headings as a replan condition.
