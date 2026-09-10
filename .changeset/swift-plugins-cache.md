---
"@runfusion/fusion": patch
---

summary: Cache each plugin TypeScript program independently during local and package builds.
category: fix
dev: Plugin build-info files now live beside each plugin's dist output, preventing cross-plugin cache collisions while preserving source-based resolution.
