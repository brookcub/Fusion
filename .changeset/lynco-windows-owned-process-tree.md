---
"@runfusion/fusion": patch
---

summary: Prove Windows sandbox process trees are empty before reporting command completion.
category: fix
dev: Run native Windows commands inside a kill-on-close Job assigned before execution, preserve timeout/cancellation truth separately from ordinary exit codes, and fail closed when cleanup cannot be proven.
