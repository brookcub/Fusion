---
"@runfusion/fusion": patch
---

summary: Preserve paused task work and prevent Windows worktree cleanup from deleting linked external files.
category: fix
dev: Long-lived executor pause exits recover in place; native cleanup admits only ignored untracked artifact junctions.
