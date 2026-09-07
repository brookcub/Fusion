#!/usr/bin/env node
// The recovery suite owns a private PostgreSQL cluster and retains its evidence.
import { mkdtempSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { URL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { withOwnedPostgres, requireStopped, pgResultPassed } from "./run-isolated-pg-gate.mjs";
import { runRegressionCommand } from "./lib/run-regression-command.mjs";
import { finishIsolatedRegression } from "./lib/finish-isolated-regression.mjs";

const root = resolve(import.meta.dirname, "..");
const evidence = mkdtempSync(join(tmpdir(), "fusion postmerge recovery "));
const home = join(evidence, "home"); mkdirSync(home);
for (const key of ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "FUSION_PG_TEST_NATIVE_ROOT", "FUSION_EMBEDDED_PG_RUNTIME_DIR", "FUSION_NATIVE_STAGING_DIR", "NODE_PATH"]) delete process.env[key];
process.env.HOME = home; process.env.USERPROFILE = home;
process.env.PSModuleAnalysisCachePath = join(evidence, "ModuleAnalysisCache");
const deadline = performance.now() + 300_000;
const lanes = [
  ["core", ["src/__tests__/post-merge-recovery-fence.pg.test.ts"]],
  ["engine", ["src/__tests__/post-merge-recovery.test.ts", "src/__tests__/workflow-graph-post-merge.test.ts", "src/__tests__/persist-workflow-step-result-abort-fence.test.ts"]],
  ["dashboard", ["src/__tests__/post-merge-recovery-route.test.ts", "src/__tests__/task-log-route.pg.test.ts"]],
];
let identity; let shutdownVerified = false; let lifecycleFailed = false; let exitCode = 1;
const results = [];
try {
  const { EmbeddedPostgresLifecycle } = await tsImport("../packages/core/src/postgres/embedded-lifecycle.ts", import.meta.url);
  const dataDir = join(evidence, "database");
  const lifecycle = new EmbeddedPostgresLifecycle({ dataDir, onLog() {}, onError() { lifecycleFailed = true; }, startTimeoutMs: 90_000 });
  exitCode = await withOwnedPostgres(lifecycle, async connection => {
    const url = new URL(connection.runtimeUrl); url.pathname = "";
    const lines = readFileSync(join(dataDir, "postmaster.pid"), "utf8").trim().split(/\r?\n/);
    identity = { pid: Number(lines[0]), port: Number(lines[3]) };
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.port !== Number(url.port)
      || resolve(lines[1]).toLowerCase() !== resolve(dataDir).toLowerCase()) throw new Error("Private database identity unavailable");
    for (const [name, files] of lanes) {
      const cwd = join(root, "packages", name);
      const require = createRequire(join(cwd, "package.json"));
      const vitest = join(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
      const reportPath = join(evidence, `${name}.json`); const log = openSync(join(evidence, `${name}.log`), "wx");
      let exit;
      try {
        exit = await runRegressionCommand(process.execPath, [vitest, "run", ...(name === "dashboard" ? ["--project", "dashboard-api"] : []), ...files,
          "--pool=forks", "--maxWorkers=1", "--reporter=json", `--outputFile=${reportPath}`], {
          cwd, deadline, stdio: ["ignore", log, log], env: { ...process.env, FUSION_DASHBOARD_DEEP: "1", FUSION_PG_TEST_SKIP: "0",
            FUSION_PG_TEST_SETUP_PARTICIPANT: "1", FUSION_PG_TEST_URL_BASE: url.toString().replace(/\/$/, "") },
        });
      } finally { closeSync(log); }
      let report; try { report = JSON.parse(readFileSync(reportPath, "utf8")); } catch { /* fail closed */ }
      const passed = pgResultPassed(exit, report);
      results.push({ lane: name, passed, exit: exit.code, tests: report?.numPassedTests ?? 0, failed: report?.numFailedTests ?? null, skipped: report?.numPendingTests ?? null });
      if (!passed) return 1;
    }
    return 0;
  }, async () => {
    if (!identity) throw new Error("Private shutdown identity unavailable");
    await requireStopped(identity);
    if (lifecycleFailed) throw new Error("Private database lifecycle failed");
    shutdownVerified = true;
  });
} catch { exitCode = 1; }
finishIsolatedRegression({ runner: "post-merge-recovery", evidence, results, shutdownVerified, outcome: exitCode === 0 ? "passed" : "failed" }, exitCode);
