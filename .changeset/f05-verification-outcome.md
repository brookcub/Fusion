---
"@runfusion/fusion": patch
---

summary: Keep verification interruption distinct from an expected command failure.
category: fix
dev: Treat only ordinary exits as satisfying expected success/failure so timeout, abort, spawn failure, or signal termination never become successful verification.
