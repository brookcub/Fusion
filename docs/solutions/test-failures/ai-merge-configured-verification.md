# Configured verification belongs to the production merger

FUSI-005 passed code review but stalled in the merge lane. Metadata-only tool
inspection showed four concurrent broad checks: `pnpm lint`, `pnpm typecheck`,
`pnpm build`, and `pnpm test`. The agent was following `buildMergeSystemPrompt`.
The sole production merger (`merge/merger-ai.ts`) never called the deterministic
verification used by the legacy merger. Project `testCommand` therefore did not
control what this lane ran or prevent an unchecked landing.

`merge/merger-ai-verification.ts` now runs explicit configured test/build commands
on the reviewed clean-room squash, before either normal or recovered landing.
An explicit test command wins unchanged; only an absent command invokes existing
inference. The shared command runner owns the timeout, cancellation, process-tree
handling and exit verdict. There is no cache, automatic retry or bootstrap in this
gate. Both configured commands must pass; no available commands means `not-run`,
not a fabricated verification success.

The returned fence is called again at the existing ref-advance boundary. It checks
clean HEAD, source SHA, task/review identity and configured commands, and re-reads
pause/settings authority after the asynchronous Git probes. Transient merge-owned
status changes use the existing `isMergeActiveStatus` vocabulary; they must not
invalidate Fusion's own transition from reviewing to landing. Review/file-scope,
write-fence and integration compare-and-swap checks remain in force.

The merger prompt no longer asks the model to discover checks. At the post-RTK
bash boundary, merger sessions refuse recognizable duplicate verification commands
with a tool error. Other lanes and the deterministic command runner are unchanged.
This is an operational guard, not a security sandbox: dynamic shell indirection
and arbitrary custom scripts are not interpreted. Ordinary Git operations and
quoted search/commit prose mentioning checks remain allowed.

## Regression evidence

Seven production-seam cases failed against the old behavior: no configured checks
ran, and failure/timeout/abort/mutation/pause cases still landed and marked done.
A focused cold review found a later pause/configuration race during the final Git
probes; four additional tests reproduced that before the final authority re-read.
The implementation also binds a value snapshot rather than a mutable task object.

The focused test files are `merger-ai-squash-gates.test.ts`,
`merger-ai-verification-fence.test.ts`, `merger-ai-verification-native.test.ts`,
`merger-verification-command-policy.test.ts`, and `bash-containment.test.ts` under
`packages/engine/src/__tests__`. They exercise real native Git repos with spaces,
real child exit 0/1, both production landing paths, required-build failure,
candidate/authority changes and duplicate-command refusal. Existing Windows-only
fixture quoting defects (single quotes and unquoted `HEAD^{tree}` through cmd.exe)
were corrected without weakening their assertions.

This source repair is not itself evidence that the preserved live ticket landed.
That requires the subsequent installed-release pilot receipt.
