// FNXC:WindowsMergeGate 2026-09-05-14:45: Exercise ordering, argv transport,
// failure propagation and PG ownership without booting Fusion or reading tasks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMergeGate, runChild, gateLanes, finalLane, parseVitestScript, vitestInvocation } from '../run-merge-gate.mjs';
import { pgResultPassed, withOwnedPostgres, requireStopped } from '../run-isolated-pg-gate.mjs';

test('static refusal prevents every test lane', async () => {
  let launched = 0;
  await assert.rejects(runMergeGate({ staticChecks: () => { throw Error('red'); }, laneRunner: () => { launched++; } }));
  assert.equal(launched, 0);
});

test('all independent lanes launch before waiting; CI waits for all successes', async () => {
  const calls = []; const complete = [];
  const pending = runMergeGate({ staticChecks: () => {}, laneRunner: (lane) => {
    calls.push(lane);
    return lane === finalLane ? { code: 0 } : new Promise((done) => complete.push(done));
  } });
  await new Promise(setImmediate);
  assert.deepEqual(calls, gateLanes);
  complete[2]({ code: 0 }); complete[0]({ code: 0 });
  await new Promise(setImmediate); assert.equal(calls.length, 3);
  complete[1]({ code: 0 }); assert.equal(await pending, 0);
  assert.equal(calls[3], finalLane);
});

for (const failure of ['nonzero', 'throw', 'reject', 'spawn']) {
  test(`lane ${failure} waits for siblings and refuses CI`, async () => {
    const calls = []; let settle; let finished = false;
    const pending = runMergeGate({ staticChecks: () => {}, laneRunner: (lane) => {
      calls.push(lane);
      if (lane === gateLanes[0]) {
        if (failure === 'throw') throw Error('red');
        if (failure === 'reject') return Promise.reject(Error('red'));
        return { code: failure === 'spawn' ? null : 7 };
      }
      if (lane === gateLanes[1]) return new Promise((done) => { settle = done; });
      return { code: 0 };
    } }).then((code) => { finished = true; return code; });
    await new Promise(setImmediate);
    assert.deepEqual(calls, gateLanes); assert.equal(finished, false);
    settle({ code: 0 }); assert.equal(await pending, 1);
    assert.equal(calls.length, 3);
  });
}

test('CI failure remains nonzero', async () => {
  assert.equal(await runMergeGate({ staticChecks: () => {}, laneRunner: (lane) => ({ code: lane === finalLane ? 7 : 0 }) }), 1);
});

test('argv preserves spaces and never starts a shell; close means stdio settled', async () => {
  const child = new EventEmitter(); let invocation;
  const pending = runChild(['C:/path with spaces/test.mjs', 'one two'], { cwd: 'C:/working directory' }, (...args) => { invocation = args; return child; });
  assert.equal(invocation[0], process.execPath);
  assert.deepEqual(invocation[1], ['C:/path with spaces/test.mjs', 'one two']);
  assert.equal(invocation[2].shell, false); assert.equal(invocation[2].windowsHide, true);
  child.emit('close', 7, null); assert.equal((await pending).code, 7);
});

test('native Node child runs from the spaced checkout', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'fusion gate argv '));
  assert.equal((await runChild(['-e', 'process.exit(process.cwd().includes(" ") ? 0 : 9)'], { cwd, stdio: 'ignore' })).code, 0);
});

test('spawn error and signal are not success', async () => {
  assert.equal((await runChild([], {}, () => { throw Error('spawn'); })).code, null);
  const child = new EventEmitter(); const pending = runChild([], {}, () => child);
  child.emit('close', null, 'SIGTERM'); assert.equal((await pending).code, null);
});

test('canonical package scripts select every lane; only Windows pool changes', () => {
  for (const lane of [...gateLanes, finalLane]) {
    const native = vitestInvocation(lane, undefined, 'win32');
    const posix = vitestInvocation(lane, undefined, 'linux');
    assert.deepEqual(native.args.slice(0, -2), posix.args);
    assert.deepEqual(native.args.slice(-2), ['--pool=forks', '--maxWorkers=1']);
    assert.equal(native.cwd, posix.cwd);
  }
  for (const script of ['X=1 vitest run a', 'vitest run a & b', 'vitest run a; b', "vitest run 'a'", 'pnpm test', 'vitest run a\nb']) assert.throws(() => parseVitestScript(script));
});

for (const stage of ['start', 'run', 'success']) {
  test(`owned PG stops after ${stage}`, async () => {
    const calls = [];
    const lifecycle = { start: async () => { calls.push('start'); if (stage === 'start') throw Error('red'); return 42; }, stop: async () => calls.push('stop') };
    const pending = withOwnedPostgres(lifecycle, async (connection) => { calls.push('run'); assert.equal(connection, 42); if (stage === 'run') throw Error('red'); return 0; });
    if (stage === 'success') assert.equal(await pending, 0); else await assert.rejects(pending);
    assert.equal(calls.at(-1), 'stop'); assert.equal(calls.filter((x) => x === 'stop').length, 1);
  });
}

test('PG cleanup failure refuses completion', async () => {
  await assert.rejects(withOwnedPostgres({ start: async () => 1, stop: async () => { throw Error('alive'); } }, async () => 0));
});

test('swallowed stop error cannot hide a surviving process or listener', async () => {
  for (const [pidGone, portGone] of [[false, true], [true, false], [false, false]]) {
    await assert.rejects(withOwnedPostgres({ start: async () => 1, stop: async () => {} }, async () => 0,
      () => requireStopped({ pid: 99, port: 10000 }, { pidAbsent: () => pidGone, portAbsent: async () => portGone, wait: async () => {}, attempts: 2 })));
  }
});

test('shutdown proof waits for both process and endpoint absence', async () => {
  let probes = 0; let waits = 0;
  await requireStopped({ pid: 99, port: 10000 }, { pidAbsent: () => ++probes > 1,
    portAbsent: async () => true, wait: async () => { waits++; }, attempts: 2 });
  assert.equal(probes, 2); assert.equal(waits, 1);
});

test('PG empty, skipped, failed or unreadable report is never green', () => {
  const good = { success: true, numPassedTests: 10, numFailedTests: 0, numPendingTests: 0 };
  assert.equal(pgResultPassed({ code: 0 }, good), true);
  for (const report of [undefined, { ...good, numPassedTests: 0 }, { ...good, numPendingTests: 1 }, { ...good, numFailedTests: 1 }, { ...good, success: false }]) assert.equal(Boolean(pgResultPassed({ code: 0 }, report)), false);
  assert.equal(pgResultPassed({ code: 7 }, good), false);
});
