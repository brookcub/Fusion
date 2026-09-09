import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn as realSpawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  CLASS_BUDGET_BANDS,
  DEFAULT_BUDGET_MULTIPLIER,
  TIMEOUT_EXIT_CODE,
  deriveBudgetMs,
  summarizeActiveHandles,
  captureHangDiagnostics,
  runWithWatchdog,
} from "../lib/run-vitest-watchdog.mjs";

function makeFakeChild() {
  const child = new EventEmitter();
  child.pid = 999999;
  child.kill = () => {};
  return child;
}

// A spawn stub that returns a controllable fake child.
function fakeSpawn(child) {
  return () => child;
}

test("deriveBudgetMs: no fresh timing falls back to the per-class ceiling", () => {
  assert.equal(deriveBudgetMs({ klass: "shard" }), CLASS_BUDGET_BANDS.shard.ceiling);
  assert.equal(
    deriveBudgetMs({ klass: "changed", expectedDurationMs: 1000, timingsFresh: false }),
    CLASS_BUDGET_BANDS.changed.ceiling,
  );
  // Zero / negative expected duration is treated as unusable → ceiling.
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 0, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.ceiling,
  );
});


test("deriveBudgetMs: fresh timing tightens within the band", () => {
  // expected×multiplier between floor and ceiling → use the tightened value.
  // 480s × 3.5 = 1680s, which sits between the shard floor (25min) and
  // ceiling (30min) so the tightened value is used un-clamped.
  const expected = 480_000; // 480s
  const derived = deriveBudgetMs({ klass: "shard", expectedDurationMs: expected, timingsFresh: true });
  assert.equal(derived, Math.round(expected * DEFAULT_BUDGET_MULTIPLIER));
  assert.ok(derived >= CLASS_BUDGET_BANDS.shard.floor);
  assert.ok(derived <= CLASS_BUDGET_BANDS.shard.ceiling);
});

test("deriveBudgetMs: clamps to floor and ceiling", () => {
  // Tiny expected → clamps up to floor.
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 1, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.floor,
  );
  // Huge expected → clamps down to ceiling.
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 10 ** 9, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.ceiling,
  );
});

test("deriveBudgetMs: shard floor pins heavy slices above the false-kill window", () => {
  // FNXC:TestInfrastructure 2026-06-20-21:52:
  // Regression guard for the 5min -> 15min shard-floor raise. A value whose
  // expected×multiplier lands in the *old* un-clamped window (300s..900s) must
  // now clamp UP to the floor. 150s × 3.5 = 525s, which was returned
  // verbatim under the old 5min floor but is below the new one. Pinning the
  // concrete floor value here means an accidental revert fails loudly
  // instead of silently re-tightening the engine/core slices into SIGKILLs.
  // FNXC:TestInfrastructure 2026-07-24-01:05:
  // Floor re-pinned 15min -> 25min after the July PG-cutover growth pushed the
  // @fusion/core slice past 900s on contended CI runners (run 30075604930
  // killed a healthy core run at exactly the floor). See CLASS_BUDGET_BANDS.
  assert.equal(CLASS_BUDGET_BANDS.shard.floor, 25 * 60_000);
  assert.equal(
    deriveBudgetMs({ klass: "shard", expectedDurationMs: 150_000, timingsFresh: true }),
    CLASS_BUDGET_BANDS.shard.floor,
  );
});

test("deriveBudgetMs: unknown class falls back to the changed band", () => {
  assert.equal(deriveBudgetMs({ klass: "nonexistent" }), CLASS_BUDGET_BANDS.changed.ceiling);
});

test("summarizeActiveHandles: returns a bounded string", () => {
  const summary = summarizeActiveHandles({ limit: 3 });
  assert.equal(typeof summary, "string");
  assert.ok(summary.length > 0);
});

test("captureHangDiagnostics: names the invocation, elapsed, and budget", () => {
  const msg = captureHangDiagnostics({
    label: "shard 1/4",
    command: "pnpm",
    args: ["test"],
    budgetMs: 1000,
    startedAt: 0,
    lastHeartbeatAt: 500,
    now: 1500,
  });
  assert.match(msg, /HANG: shard 1\/4/);
  assert.match(msg, /elapsed 1500ms/);
  assert.match(msg, /budget 1000ms/);
  assert.match(msg, /last heartbeat: 1000ms ago/);
});

test("runWithWatchdog: clean exit propagates code 0, no kill", async () => {
  const child = makeFakeChild();
  const killed = [];
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "clean",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: (sig) => killed.push(sig),
  });
  child.emit("close", 0, null);
  const result = await p;
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.signal, null);
  assert.deepEqual(killed, []);
});

test("runWithWatchdog: non-zero exit code is propagated unchanged", async () => {
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "fails",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: () => {},
  });
  child.emit("close", 7, null);
  const result = await p;
  assert.equal(result.code, 7);
  assert.equal(result.timedOut, false);
});

test("runWithWatchdog: timeout fires SIGTERM then SIGKILL and returns 124", async () => {
  const child = makeFakeChild();
  const killed = [];
  let diagnosticsLogged = "";
  const p = runWithWatchdog({
    command: "pnpm",
    args: ["exec", "vitest"],
    budgetMs: 30, // fire fast
    graceMs: 20,
    heartbeatMs: 1000,
    label: "hanger",
    log: (m) => {
      diagnosticsLogged += m + "\n";
    },
    spawn: fakeSpawn(child),
    killGroup: (sig) => {
      killed.push(sig);
      // Emulate the group dying only after SIGKILL.
      if (sig === "SIGKILL") setTimeout(() => child.emit("close", null, "SIGKILL"), 1);
    },
  });
  const result = await p;
  assert.equal(result.timedOut, true);
  assert.equal(result.code, TIMEOUT_EXIT_CODE);
  assert.deepEqual(killed, ["SIGTERM", "SIGKILL"]);
  assert.match(diagnosticsLogged, /HANG: hanger/);
});

test("runWithWatchdog: child error rejects", async () => {
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "errors",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: () => {},
  });
  child.emit("error", new Error("spawn failed"));
  await assert.rejects(p, /spawn failed/);
});

test("runWithWatchdog: removes its process listeners after settling", async () => {
  const beforeTerm = process.listenerCount("SIGTERM");
  const beforeExit = process.listenerCount("exit");
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "fake",
    args: [],
    budgetMs: 10_000,
    label: "cleanup",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: () => {},
  });
  child.emit("close", 0, null);
  await p;
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
  assert.equal(process.listenerCount("exit"), beforeExit);
});

test("runWithWatchdog: forwarded signal escalates to SIGKILL after grace", async () => {
  const child = makeFakeChild();
  const killed = [];
  const p = runWithWatchdog({
    command: "pnpm",
    args: [],
    budgetMs: 10_000,
    graceMs: 15,
    heartbeatMs: 1000,
    label: "cancel",
    log: () => {},
    spawn: fakeSpawn(child),
    killGroup: (sig) => {
      killed.push(sig);
      // The child ignores SIGHUP; only SIGKILL takes it down.
      if (sig === "SIGKILL") child.emit("close", null, "SIGKILL");
    },
  });
  // Simulate external cancellation (Ctrl-C / CI cancel) reaching the wrapper.
  process.emit("SIGHUP");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await p;
  assert.deepEqual(killed, ["SIGHUP", "SIGKILL"]);
});

test("runWithWatchdog: passes cwd through to spawn when provided", async () => {
  let capturedOpts = null;
  const child = makeFakeChild();
  const p = runWithWatchdog({
    command: "pnpm",
    args: ["test"],
    cwd: "/tmp/repo-root",
    budgetMs: 10_000,
    label: "cwd",
    log: () => {},
    spawn: (_cmd, _args, opts) => {
      capturedOpts = opts;
      return child;
    },
    killGroup: () => {},
  });
  child.emit("close", 0, null);
  await p;
  assert.equal(capturedOpts.cwd, "/tmp/repo-root");
});

test("runWithWatchdog preserves real argv containing spaces and metacharacters", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog argv & "));
  const output = join(root, "received args.json");
  const fixture = resolve(import.meta.dirname, "fixtures", "native-job-argv.mjs");
  const args = [fixture, output, "space value", "literal & value"];
  try {
    const result = await runWithWatchdog({
      command: process.execPath, args, budgetMs: 10_000, label: "argv-roundtrip", log: () => {},
      spawn: realSpawn, windowsJob: true,
    });
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), ["space value", "literal & value"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

async function waitForIdentity(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error("descendant identity was not written");
    await new Promise((done) => setTimeout(done, 20));
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

async function assertDescendantGone(identity) {
  assert.throws(() => process.kill(identity.pid, 0), { code: "ESRCH" });
  const refused = await new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port: identity.port });
    const finish = (value) => { socket.destroy(); done(value); };
    socket.on("connect", () => finish(false));
    socket.on("error", (error) => finish(error.code === "ECONNREFUSED"));
    socket.setTimeout(500, () => finish(false));
  });
  assert.equal(refused, true);
}

test("runWithWatchdog native Job reaps a child and detached grandchild on timeout", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog job timeout "));
  const identityPath = join(root, "identity.json");
  const descendant = `const net=require('node:net'),fs=require('node:fs');const server=net.createServer();server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port})));`;
  const parent = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(identityPath)}],{detached:true,windowsHide:true,stdio:'ignore'});setInterval(()=>{},1000);`;
  try {
    const result = await runWithWatchdog({ command: process.execPath, args: ["-e", parent], budgetMs: 700, label: "job-timeout", log: () => {}, spawn: realSpawn, windowsJob: true });
    assert.equal(result.code, TIMEOUT_EXIT_CODE);
    assert.equal(result.timedOut, true);
    assert.match(result.diagnostics, /HANG: job-timeout/);
    await assertDescendantGone(await waitForIdentity(identityPath));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runWithWatchdog preserves ordinary native exits 124 and 125", { skip: process.platform !== "win32" }, async () => {
  for (const code of [124, 125]) {
    const result = await runWithWatchdog({ command: process.execPath, args: ["-e", `process.exit(${code})`], budgetMs: 10_000, label: `ordinary-${code}`, log: () => {}, spawn: realSpawn, windowsJob: true });
    assert.equal(result.code, code);
    assert.equal(result.timedOut, false);
    assert.equal(result.signal, null);
  }
});

test("native Job helper preserves the legacy no-receipt invocation", { skip: process.platform !== "win32" }, () => {
  const helper = resolve(import.meta.dirname, "..", "lib", "run-owned-windows-command.ps1");
  const args64 = Buffer.from(JSON.stringify(["-e", "process.exit(7)"])).toString("base64");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", helper, "-Executable", process.execPath, "-ArgumentsBase64", args64, "-TimeoutMs", "10000"], { encoding: "utf8" });
  assert.equal(result.status, 7);
});

test("runWithWatchdog honors a disabled native budget", { skip: process.platform !== "win32" }, async () => {
  const result = await runWithWatchdog({ command: process.execPath, args: ["-e", "setTimeout(() => process.exit(0), 75)"], budgetMs: 0, label: "disabled-budget", log: () => {}, spawn: realSpawn, windowsJob: true });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
});

test("runWithWatchdog rejects a missing native completion receipt", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(
    runWithWatchdog({ command: process.execPath, args: ["-e", "process.exit(0)"], budgetMs: 10_000, label: "missing-receipt", log: () => {}, spawn: realSpawn, windowsJob: true, nativeHelperPath: join(tmpdir(), "missing-native-helper.ps1") }),
    /outcome receipt missing or malformed/,
  );
});

test("native setup refusal removes handlers and terminates its helper", async () => {
  const before = process.listenerCount("SIGHUP");
  const child = makeFakeChild();
  let killed = false;
  child.kill = () => { killed = true; child.emit("close", null, "SIGTERM"); };
  const running = runWithWatchdog({command: "fixture", args: [], spawn: fakeSpawn(child),
    windowsJob: true, budgetMs: 1000, nativeDeadlines: { setupMs: 10, cleanupMs: 10 }, log: () => {}});
  const refused = assert.rejects(running, /setup.*unproven/);
  await new Promise(done => setTimeout(done, 40));
  await refused;
  assert.equal(killed, true);
  assert.equal(process.listenerCount("SIGHUP"), before);
});

test("native helper failure during cancellation never reports successful cancellation", async () => {
  const child = makeFakeChild();
  let outcome;
  const running = runWithWatchdog({ command: "fixture", args: [], windowsJob: true,
    budgetMs: 1000, log: () => {}, spawn: (_command, args) => {
      outcome = args[args.indexOf("-OutcomeFile") + 1]; return child;
    }});
  const refused = assert.rejects(running, /unproven/);
  process.emit("SIGHUP");
  writeFileSync(outcome, JSON.stringify({outcome: "helper-failure", jobEmpty: false}));
  child.emit("close", 125, null);
  await refused;
});

test("native ready helper that ignores cancellation is bounded and never green", async () => {
  const child = makeFakeChild();
  let killed = false;
  child.kill = () => { killed = true; child.emit("close", null, "SIGTERM"); };
  const before = process.listenerCount("SIGHUP");
  const running = runWithWatchdog({command: "fixture", args: [], windowsJob: true,
    budgetMs: 0, nativeDeadlines: {setupMs: 100, cleanupMs: 10}, log: () => {},
    spawn: (_command, args) => { writeFileSync(args[args.indexOf("-ReadyFile")+1], "ready"); return child; }});
  const refused = assert.rejects(running, /cancellation deadline.*unproven/);
  process.emit("SIGHUP");
  await new Promise(done => setTimeout(done, 40));
  await refused;
  assert.equal(killed, true);
  assert.equal(process.listenerCount("SIGHUP"), before);
});

test("native malformed or contradictory completion receipts are refused", async () => {
  for (const content of ["broken-json", '{"outcome":"exit","exitCode":0,"jobEmpty":false}',
      '{"outcome":"timeout","exitCode":0,"jobEmpty":true}',
      '{"outcome":"cancelled","exitCode":0,"jobEmpty":true}']) {
    const child = makeFakeChild();
    const running = runWithWatchdog({command: "fixture", args: [], windowsJob: true,
      budgetMs: 1000, log: () => {}, spawn: (_command, args) => {
        writeFileSync(args[args.indexOf("-OutcomeFile")+1], content); return child;
      }});
    const refused = assert.rejects(running, /malformed|unproven/);
    child.emit("close", 0, null);
    await refused;
  }
});

test("runWithWatchdog native Job reaps descendants when its parent is cancelled", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "watchdog job cancel "));
  const identityPath = join(root, "identity.json");
  const descendant = `const net=require('node:net'),fs=require('node:fs');const server=net.createServer();server.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[1],JSON.stringify({pid:process.pid,port:server.address().port})));`;
  const parent = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(identityPath)}],{detached:true,windowsHide:true,stdio:'ignore'});setInterval(()=>{},1000);`;
  try {
    const running = runWithWatchdog({ command: process.execPath, args: ["-e", parent], budgetMs: 10_000, graceMs: 100, label: "job-cancel", log: () => {}, spawn: realSpawn, windowsJob: true });
    const identity = await waitForIdentity(identityPath);
    process.emit("SIGHUP");
    const result = await running;
    assert.equal(result.timedOut, false);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGHUP");
    await assertDescendantGone(identity);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
