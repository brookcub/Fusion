#!/usr/bin/env node
// FNXC:WindowsMergeGate 2026-09-05-14:45: The blocking PG lane owns a new private
// cluster, never a caller's database; a green skipped/empty suite is not proof.
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { tsImport } from 'tsx/esm/api';
import { gateLanes, vitestInvocation, runChild } from './run-merge-gate.mjs';

export function pgResultPassed(exit, report) {
  return exit.code === 0 && report?.success === true && report.numPassedTests > 0
    && report.numFailedTests === 0 && report.numPendingTests === 0;
}

export async function withOwnedPostgres(lifecycle, run, verifyStopped = async () => {}) {
  try { return await run(await lifecycle.start()); }
  finally { await lifecycle.stop(); await verifyStopped(); }
}

export async function finishGateProcess(code) {
  // FNXC:RequiredPgGate 2026-09-09-14:53: embedded-postgres registers
  // async-exit-hook, whose beforeExit handler exits
  // with a fixed zero and overrides process.exitCode. Cleanup/absence proof
  // must finish first; then flush the receipt and preserve the actual verdict.
  await Promise.all([process.stdout, process.stderr].map((stream) =>
    new Promise((done) => stream.write('', done))));
  process.exit(code);
}

export function processAbsent(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export function endpointAbsent(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (absent) => { socket.destroy(); done(absent); };
    socket.once('connect', () => finish(false));
    socket.once('error', (error) => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(false));
  });
}

export async function requireStopped(identity, { pidAbsent = processAbsent, portAbsent = endpointAbsent,
  wait = delay, attempts = 20 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (pidAbsent(identity.pid) && await portAbsent(identity.port)) return;
    if (attempt + 1 < attempts) await wait(100);
  }
  throw Error('owned PostgreSQL shutdown unproven');
}

export async function runIsolatedPgGate({ invocation: selectedInvocation } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'fusion pg gate '));
  const home = join(directory, 'home'); mkdirSync(home);
  // This process is only the PG lane. Isolate native staging and test state too.
  process.env.HOME = home; process.env.USERPROFILE = home;
  for (const key of ['DATABASE_URL','PGHOST','PGPORT','PGUSER','PGPASSWORD','PGDATABASE','FUSION_PG_TEST_NATIVE_ROOT','FUSION_EMBEDDED_PG_RUNTIME_DIR']) delete process.env[key];
  // Source import works in a clean checkout without an unrelated full build.
  const { EmbeddedPostgresLifecycle } = await tsImport('../packages/core/src/postgres/embedded-lifecycle.ts', import.meta.url);
  const dataDir = join(directory, 'database');
  let lifecycleError = false; let identity; let receipt;
  const lifecycle = new EmbeddedPostgresLifecycle({ dataDir, onLog() {}, onError() { lifecycleError = true; }, startTimeoutMs: 90000 });
  const result = await withOwnedPostgres(lifecycle, async (connection) => {
    const url = new URL(connection.runtimeUrl); url.pathname = '';
    const lines = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').trim().split(/\r?\n/);
    identity = { pid: Number(lines[0]), port: Number(lines[3]) };
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.port !== Number(url.port)
      || resolve(lines[1]).toLowerCase() !== resolve(dataDir).toLowerCase()) throw Error('private PostgreSQL identity unproven');
    const reportPath = join(directory, 'vitest.json');
    const log = openSync(join(directory, 'vitest.log'), 'wx');
    let exit;
    try {
      // Focused integration tests can reuse the same private-cluster ownership,
      // zero-skip acceptance and verified shutdown instead of inventing a runner.
      const invocation = selectedInvocation ?? vitestInvocation(gateLanes.find((lane) => lane.postgres));
      const args = invocation.args.filter((arg) => !arg.startsWith('--reporter='));
      // JSON alone omits suite-level setup errors in this Vitest version.
      // Keep human diagnostics in the private lane log, not the public receipt.
      args.push('--reporter=default', '--reporter=json', '--outputFile=' + reportPath);
      exit = await runChild(args, { cwd: invocation.cwd, stdio: ['ignore', log, log],
        env: { ...process.env, FUSION_PG_TEST_URL_BASE: url.toString().replace(/\/$/, ''), FUSION_PG_TEST_SKIP: '0', FUSION_PG_TEST_REQUIRED: '1', FUSION_PG_TEST_SETUP_PARTICIPANT: '1' } });
    } finally { closeSync(log); }
    let report;
    try { report = JSON.parse(readFileSync(reportPath, 'utf8')); } catch { /* fail closed below */ }
    const passed = pgResultPassed(exit, report);
    receipt = { lane: 'test:pg-gate', passed, tests: report?.numPassedTests ?? 0,
      skipped: report?.numPendingTests ?? null, failedSuites: report?.numFailedTestSuites ?? null,
      childExit: exit.code, evidence: directory };
    return passed ? 0 : 1;
  }, async () => {
    if (identity) await requireStopped(identity);
    if (lifecycleError) throw Error('private PostgreSQL lifecycle reported failure');
  });
  console.log(JSON.stringify({ ...receipt, shutdownVerified: true }));
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let code = 1;
  try { code = await runIsolatedPgGate(); }
  catch { console.error('[pg-gate] private setup or cleanup failed'); }
  await finishGateProcess(code);
}
