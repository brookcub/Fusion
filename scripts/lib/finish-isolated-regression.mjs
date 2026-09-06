// FNXC:TaskLogRegression 2026-09-06-13:38: embedded-postgres installs a
// beforeExit hook that forces zero. Only after owned cleanup is proven, flush
// the receipt and explicitly exit with the regression's captured verdict.
export function finishIsolatedRegression(receipt, code) {
  const exitCode = Number.isInteger(code) && code === 0 ? 0 : 1;
  process.stdout.write(`${JSON.stringify(receipt)}\n`, () => process.exit(exitCode));
}
