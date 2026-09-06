---
title: Final review receives candidate-bound verification evidence
applies_when: A tiny task lands successfully but final review cannot identify the latest configured-check result.
---

The isolated smoke reached a real merge and its engine-owned candidate byte check
exited zero. Final review nevertheless returned REVISE. This does not prove which
historical result the model used. It exposed two deterministic missing contracts:
the review prompt received neither merge proof nor structured check evidence, and
graph materialization labeled even post-merge group children as pre-merge.

## Why better

The existing merge-details JSON carries bounded engine-owned receipts, without a
database migration or a separate artifact authority. A receipt records candidate,
source, configuration hash, command hashes, timestamps and strict exit-zero checks;
it does not copy command text, output, credentials or model prose. A new attempt
first persists pending evidence. Failed checks cannot leave an older passing
receipt authoritative. Durability failure refuses landing.

Finalization retains the receipts. The actual graph now carries the parent's phase
to the workflow session. A readonly post-merge reviewer receives matching merge
proof and validated results explicitly. These are **pre-landing checks of the
exact landed commit**, not a claim of fresh post-landing execution and not an
instruction to approve. Earlier failures remain history. Missing, mismatched or
pending receipts are unavailable; no applicable commands is not-run, never passed.
Workspace repositories sharing one SHA are deliberately unavailable until receipt
identity can distinguish repositories. A post-push rebase also invalidates an old
candidate receipt. Neither case is silently green.

Candidate receipts do not count as landing proof in completed-work recovery. They
cannot send finished implementation back through execution after a pause/restart.

## Validation

The receipt baseline reproduced two failures before implementation. A real
optional-group-to-session regression separately reproduced the lost post-merge
phase, with its pre-merge control passing. Focused tests cover rejected exits,
cache/timeout refusal, durability failure, stale/pending and mismatched receipts,
same-SHA workspace aliases, actual reviewer prompt delivery, completed-work resume,
native command exits, and preservation through real Git merge finalization.
Operational model runs and release evidence remain in the Task System recovery
chronology; unit tests do not imply that the next real-model smoke has passed.
