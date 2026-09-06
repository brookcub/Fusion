#!/usr/bin/env node
// FNXC:WindowsMergeGate 2026-09-05-14:45: Windows cmd cannot protect POSIX
// background/wait syntax with single quotes. Keep the same lanes, using argv.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readStaticGateChecks, runStaticGateChecks } from './run-static-gate-checks.mjs';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Lane membership/order lives here; each package script remains authoritative
// for its exact test selection. No copied list of test files or weaker fallback.
export const gateLanes = Object.freeze([
  { package: 'packages/engine', script: 'test:core' },
  { package: 'packages/core', script: 'test:pg-gate', postgres: true },
  { package: 'packages/core', script: 'test:unit-gate' },
]);
export const finalLane = Object.freeze({ package: 'packages/cli', script: 'test:ci-shape' });

export function parseVitestScript(command) {
  if (typeof command !== 'string' || /[;&|$`'"\r\n]/.test(command)) throw new Error('unsupported gate script syntax');
  const [binary, ...args] = command.trim().split(/\s+/);
  if (binary !== 'vitest' || args[0] !== 'run') throw new Error('gate lane must be a direct vitest run');
  return args;
}

export function vitestInvocation(lane, repoRoot = root, platform = process.platform) {
  const cwd = resolve(repoRoot, lane.package);
  const manifest = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'));
  const args = parseVitestScript(manifest.scripts?.[lane.script]);
  // The measured Windows thread-pool crashes are not test passes. Match the
  // existing recovery runs' native fork execution without changing other hosts.
  if (platform === 'win32') args.push('--pool=forks', '--maxWorkers=1');
  const require = createRequire(resolve(cwd, 'package.json'));
  return { cwd, args: [resolve(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), ...args] };
}

export function runChild(args, options = {}, spawnImpl = spawn) {
  return new Promise((done) => {
    let child;
    try { child = spawnImpl(process.execPath, args, { shell: false, windowsHide: true, stdio: 'inherit', ...options }); }
    catch { done({ code: null, spawnFailed: true }); return; }
    child.once('error', () => done({ code: null, spawnFailed: true }));
    child.once('close', (code, signal) => done({ code, signal }));
  });
}

export async function runLane(lane) {
  if (lane.postgres) return runChild([resolve(root, 'scripts/run-isolated-pg-gate.mjs')], { cwd: root });
  const invocation = vitestInvocation(lane);
  return runChild(invocation.args, { cwd: invocation.cwd });
}

export async function runMergeGate({ staticChecks = () => runStaticGateChecks(readStaticGateChecks()), laneRunner = runLane } = {}) {
  await staticChecks();
  // A failure never hides still-running siblings. All settle before CI shape.
  const outcomes = await Promise.allSettled(gateLanes.map((lane) => Promise.resolve().then(() => laneRunner(lane))));
  if (outcomes.some((x) => x.status !== 'fulfilled' || x.value?.code !== 0)) return 1;
  try { return (await laneRunner(finalLane))?.code === 0 ? 0 : 1; }
  catch { return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await runMergeGate(); }
  catch { console.error('[merge-gate] preflight failed'); process.exitCode = 1; }
}
