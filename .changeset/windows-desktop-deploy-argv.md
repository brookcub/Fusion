---
"@fusion/desktop": patch
"@runfusion/fusion": patch
---

summary: Preserve spaced Windows paths during desktop dependency staging.
category: fix
dev: Invoke the canonical pnpm or Corepack JavaScript entrypoint through Node,
without shell re-parsing. A native argument round-trip regression covers spaces
and shell metacharacters in deployment destinations.
