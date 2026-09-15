---
"@runfusion/fusion": patch
---

summary: Recreate required JavaScript outputs after incremental build artifacts disappear.
category: fix
dev: Invalidate package-local TypeScript buildinfo when a required output is missing before invoking the package build.
