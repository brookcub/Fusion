---
"@fusion/core": patch
"@fusion/engine": patch
---

summary: Support a narrowly scoped read-only external Codex login reference.
category: fix
dev: Read only the explicit canonical login file, observe owner rotation and revocation
at use time, and refuse credential writes, refresh, or near-expiry activation. Keep
status and runtime availability consistent without copying another credential file.
