# Packaged runtime correctness

The first sealed candidate at 41ecba37d6fe3b474816f11dc47393c38f312d6c
completed preparation in 841.131 seconds, but was rejected before deployment.
Its emitted native backend used a bare JSON import that plain Node refused with
ERR_IMPORT_ATTRIBUTE_MISSING. Vitest and bundled execution hid the incompatibility.

The shared Windows supervisor program now lives in one JSON-escaped TypeScript
data module. TypeScript emits an ordinary JS import; the developer PowerShell
shim parses the same exact literal. Independent review verified byte equality
with the preserved original helper (decoded SHA-256
0DB4A3A24EE121F74EA6626CEAAFD61067114FB63AE6DFB7894C98C6BE194E5A).
Engine builds now load the emitted native backend under plain Node before they
can succeed, with a ten-second bound.

Full CLI packaging previously trusted an existing desktop/dist directory even
when its embedded engine was stale. It now refreshes that closure before staging
it. Fast local CLI builds continue to skip desktop packaging. This fixes artifact
identity without introducing another cache or changing the developer fast path.

## Validation

- Engine build, including plain-Node import: exit 0.
- Real compiled native echo command: exit 0, exact stdout matched, no timeout.
  The first handwritten smoke omitted required maxBuffer and therefore captured
  no output; it was corrected to supply the backend's required argument.
- Native command / hostile receipt / streaming regressions: 29/29, 18.3 seconds.
- Shared watchdog regressions: 26/26, 8.124 seconds.
- Full-package desktop freshness regressions: 4/4, independently reproduced.
- CLI source typecheck: exit 0 (Terra). Scoped changed-source lint and changeset
  validation: exit 0. The first new MJS lint run caught missing explicit Node
  imports; those were added and the same check passed.
- Cold review: Terra checked the source relocation; root reviewed the desktop
  freshness implementation. No implementation blocker remains in these deltas.

The preceding integrated candidate passed the 720-test merge gate and 102 focused
tests with one existing skip. These are distinct evidence, not a claim to have
rerun every test after these packaging changes. A new sealed package and private
lifecycle rehearsal are still required. The rejected package is retained as
historical evidence and must not be deployed. No live cutover or resumed-ticket
completion is asserted here.
