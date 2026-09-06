---
title: Merge review honors the task's model authority
applies_when: Implementation and code review succeed but the merge reviewer uses a different provider or model.
---

`makeReviewAgent` previously read only project/global validator settings even
when the task had an explicit validator provider/model/credential/thinking
selection. A bounded pilot selected Luna for the task, while saved global
validator settings selected Spark. The source and settings confirm that routing
divergence; they do not independently prove why the subsequent task API timed out.

The factory now uses the same `resolveValidatorSessionModel` and task thinking
resolver as ordinary review. Complete task pairs take precedence, incomplete
pairs retain project fallback, and test mode still forces the mock provider.
Existing merger-model fallback remains unchanged. A missing or unreadable task
refuses reviewer creation instead of silently substituting project defaults.

## Why this is simpler

One existing resolver owns the model hierarchy. There is no new model setting,
pilot exception, activation gate, or credential copy. The real-factory regressions
exercise both clean-approval reviewer sessions with conflicting project defaults,
partial task pairs, test mode, and unavailable task authority. They reproduced
the old wrong-model and silent-fallback behavior before the correction.

## Failure evidence

`merge-failure-evidence.ts` records fixed stage/kind/code/category fields and
bounded source coordinates before cleanup. Error prose, absolute paths, commands,
task contents, credentials and model output are excluded. Privacy regressions
include changing getters and a throwing logger. The original exception and normal
cleanup remain authoritative; diagnostics are not a success or recovery verdict.
