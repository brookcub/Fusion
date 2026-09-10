# Local Fusion fixes: publication inventory

Prepared 2026-09-10 for the cloud integration team. This records source snapshots,
not merge/deployment approval. No product tests were rerun for publication.

## Ticket work to compare with PR #1

| Branch | Exact head | Contents and limitations |
| --- | --- | --- |
| `fusion/fusi-007` | `6866203027b5cf3d829c529267f45f8d5e1d176d` | Candidate-bound verification and completion evidence, UI visibility, preservation of incomplete landed work. Five prior commits plus one WIP checkpoint of four local files. |
| `fusion/fusi-010` | `e83de1cc9f1472d00ded8ae1866b05d0fb26b1e5` | Bounded interleaved review-stall reporting and recovery documentation; two commits beyond the published baseline lineage. |
| `fusion/fusi-013` | `f1921f833c9c41e258f0ffc23aa57c48e822defd` | Missing task-log write classification, real-store PostgreSQL route regressions, bounded Windows process harness and PowerShell cache isolation; three commits. |
| `fusion/fusi-017` | `01259ca157ad37c044c6d6a6bc1b49c7054ffe26` | Cancellation-safe completion/continuation handoff and verification tests; two prior commits plus a WIP checkpoint of two local files. |
| `recovery/fusi005-preserved-945b4ac0` | `945b4ac0d5d31409eb52c0cb03d874726c0f5e90` | Preserved dashboard listen-port fix, explicit zero-port behavior and CLI tests. Historical branch with integration merges; compare selectively, do not replay wholesale. |

These branches contain real implementations and tests but are NOT evidence that
the tickets reached verified, merged, settled DONE. Branch names and commit
messages are not acceptance receipts. PR #1 is the newer integration base;
compare behavior and port only remaining gaps.

### Exact WIP details

- FUSI-007: `verification-evidence.ts` gives a current passing receipt the
  `current-pass` reason rather than `not-run`; the executor model test follows
  that representation. Claude probe timeout setup moves before spawning;
  native environment defaults use `globalThis.process.env`.
- FUSI-017: the same probe timeout edit, but the native environment module uses
  `import process from "node:process"` instead. These are alternative local
  edits, not a directive to combine both. Assess against current upstream.
- Neither checkpoint was newly tested, reviewed or deployed during publication.

## Earlier implementation branches retained for provenance

| Branch | Exact head | Interpretation |
| --- | --- | --- |
| `codex/fusion-e2e-reliability` | `54fade29987e1559c5bd334d2d5b4132a85d1939` | Early pause and verification invariant implementation/regressions. Historical checkpoint; later code may supersede it. Not a unique remaining-fix claim. |
| `codex/upstream-startup-task-cache` | `88820f15276721de55e79791c3407d93d0b06e2c` | Deleted-visibility startup-cache correction. Git patch-equivalence check shows it is already incorporated in `851bb61c4`. |
| `codex/upstream-windows-tool-paths` | `2715297b8c981aed1f29ff59d3994bf62ca51cf3` | Spaced Windows build-tool paths and tests. Both commits are patch-equivalent to changes already incorporated in `851bb61c4`. |

Other local development, postmerge-recovery, pause-preservation, model-routing,
checkpoint-settlement and build-performance branch heads are already reachable
through the published baseline/candidate/audit history. They need no duplicate
implementation import merely because their original branch names were local.

## Already published context

- Installed-source baseline `lab-integration`: `0fcaffeaf48ef21c10dfbf70dbe4b5f90423b40f`.
- Earlier tested candidate `codex/verification-queue-visibility`: `851bb61c4ef26940675565cf84488481cfff1f94`.
- Reviewer WIP `codex/foreach-settings-forwarding`: `507ddc85f18322fb8607f9fd293d0a6ce4aca47e`.
- PR #1 `codex/fusion-upstream-reliability`: last verified `795f80012036d4ed53533cf2378d2c20195a2b8f`.
- Audit code snapshot: `df38b799ba84d1062192bd8574bf8b9f0d9e8f46`;
  this publication only updates its handoff documentation.

The strict-settings interception draft is audit context, not recommended to
import wholesale. Follow the PR handoff's existing-resolver/provenance approach.

## Deliberately not published

- Failure-injection-only startup rehearsal branch: deliberately broken fixture,
  not a product fix.
- Runtime data, credentials, task records, model logs, untracked result JSON,
  generated skill line-ending changes and PowerShell module caches.
- Temporary FUSI-013 baseline-test copies: four byte variants exist, one matching
  the committed test and three differing. They remain local as historical
  regression-development material, not selected implementation candidates.
- Duplicate recovery pointers; the selected FUSI-005 and FUSI-013 branch tips
  already retain their associated preserved ancestor commits.

Nothing was deleted. GitHub main, PR #1 and the installed release were not
modified by this publication. Preserve the board-availability versus execution-
readiness distinction in the main audit handoff.
