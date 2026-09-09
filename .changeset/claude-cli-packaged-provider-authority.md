---
"@runfusion/fusion": patch
---

summary: Use the bundled native Claude adapter in packaged sessions with isolated working directories.
category: fix
dev: Share the CLI/engine resolver, exclude renamed adapter packages before both SDK extension-loading passes, and restrict the native Claude provider ID to the bundled registration. Bind native stream cwd per session without changing other providers or process-global state.
