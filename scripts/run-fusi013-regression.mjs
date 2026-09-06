#!/usr/bin/env node
/*
FNXC:TaskLogRegression 2026-09-06-13:20:
FUSI-013 proves the named missing-task HTTP assertion against the exact unchanged
source and the candidate in isolated PostgreSQL. The baseline wires each source package
used by the mounted route to its installed dependencies and preserves inspectable evidence.
*/
import { closeSync, cpSync, existsSync, mkdtempSync, mkdirSync, openSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { URL } from "node:url";
import { createRequire } from "node:module";
import { tsImport } from "tsx/esm/api";
import { endpointAbsent, pgResultPassed, processAbsent, requireStopped, withOwnedPostgres } from "./run-isolated-pg-gate.mjs";
import { runRegressionCommand } from "./lib/run-regression-command.mjs";
import { readWorkspacePackageGraph } from "./check-workspace-package-graph.mjs";
import { finishIsolatedRegression } from "./lib/finish-isolated-regression.mjs";
import { createHash } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const deadline = performance.now() + 150_000;
const baselineRevision = "f7341e88fc787508a1fc7424eacd20c48d4857fb";
const directory = mkdtempSync(join(tmpdir(), "fusion fusi013 "));
const evidenceDir = join(directory, "evidence");
const home = join(directory, "home");
const baselineRoot = join(directory, "baseline");
mkdirSync(home);
mkdirSync(evidenceDir);

for (const key of ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "FUSION_PG_TEST_NATIVE_ROOT", "FUSION_EMBEDDED_PG_RUNTIME_DIR", "FUSION_NATIVE_STAGING_DIR", "NODE_PATH"]) delete process.env[key];
process.env.HOME = home;
process.env.USERPROFILE = home;

function runGit(args, cwd = root) {
  return runRegressionCommand("git", args, { cwd, deadline, stdio: "ignore" });
}

async function readRevision(cwd) {
  const result = await runRegressionCommand("git", ["rev-parse", "HEAD"], { cwd, deadline, stdio: ["ignore", "pipe", "ignore"] });
  return result.code === 0 ? result.output.trim() : null;
}

function reportFor(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
}

function reportCounts(report) {
  return { passed: report?.numPassedTests ?? 0, failed: report?.numFailedTests ?? -1, pending: report?.numPendingTests ?? -1 };
}

function hasBaseline404Failure(report) {
  const expectedTitle = "returns 404 without mutation for a wholly nonexistent well-formed task id";
  const results = report?.testResults ?? report?.tests ?? [];
  const assertions = results.flatMap((result) => result.assertionResults ?? result.tests ?? []);
  const absentTaskAssertion = assertions.find((assertion) => assertion.title === expectedTitle || assertion.fullName?.endsWith(expectedTitle));
  const failures = absentTaskAssertion?.failureMessages ?? absentTaskAssertion?.errors ?? [];
  return absentTaskAssertion?.status === "failed"
    && failures.some((failure) => String(failure).includes("expected 500 to be 404"));
}

async function runFocusedTest(cwd, testFile, connection, label) {
  const require = createRequire(join(root, "packages", "dashboard", "package.json"));
  const vitest = resolve(dirname(require.resolve("vitest/package.json")), "vitest.mjs");
  const reportPath = join(evidenceDir, `${label}-report.json`);
  const log = openSync(join(evidenceDir, `${label}.log`), "wx");
  let exit;
  try {
    exit = await runRegressionCommand(process.execPath, [vitest, "run", "--config", "vitest.config.ts", "--project", "dashboard-api", testFile, ...(process.platform === "win32" ? ["--pool=forks", "--maxWorkers=1"] : []), "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`], {
      cwd,
      deadline,
      stdio: ["ignore", log, log],
      env: { ...process.env, FUSION_DASHBOARD_DEEP: "1", FUSION_PG_TEST_URL_BASE: connection, FUSION_PG_TEST_SKIP: "0", FUSION_PG_TEST_SETUP_PARTICIPANT: "1" },
    });
  } finally {
    closeSync(log);
  }
  return { exit, report: reportFor(reportPath) };
}

function linkPackageDependencies(destination, source) {
  if (!existsSync(destination)) symlinkSync(source, destination, process.platform === "win32" ? "junction" : "dir");
}

async function createBaselineWorktree() {
  if ((await runGit(["worktree", "add", "--detach", baselineRoot, baselineRevision])).code !== 0) throw new Error("baseline worktree setup failed");
  const baselineTest = join(baselineRoot, "packages", "dashboard", "src", "__tests__", "task-log-route.pg.test.ts");
  cpSync(join(root, "packages", "dashboard", "src", "__tests__", "task-log-route.pg.test.ts"), baselineTest);
  // FNXC:TaskLogRegression 2026-09-06-13:30: Mounted routes load workspace
  // plugins too. Wire installed dependencies from the canonical package graph,
  // while keeping every baseline production source file at its pinned revision.
  const graph = readWorkspacePackageGraph({ root: baselineRoot });
  if (graph.violations.length) throw new Error("baseline package inventory invalid");
  for (const { filePath } of graph.manifests) {
    const directory = dirname(filePath);
    const source = join(root, directory, "node_modules");
    if (existsSync(source)) linkPackageDependencies(join(baselineRoot, directory, "node_modules"), source);
  }
  return baselineTest;
}

let identity;
let stage = "baseline-worktree";
let lifecycleFailed = false;
let exitCode = 1;
let receipt = { baseline: { source: baselineRevision, exit: null, ...reportCounts() }, candidate: { source: null, exit: null, ...reportCounts() }, evidence: evidenceDir, shutdownVerified: false };

try {
  await createBaselineWorktree();
  const baselineSource = await readRevision(baselineRoot);
  if (baselineSource !== baselineRevision) throw new Error("baseline source identity mismatch");
  stage = "candidate-identity";
  const candidateRevision = await readRevision(root);
  if (!candidateRevision) throw new Error("candidate source identity unavailable");
  receipt.exercisedFiles = Object.fromEntries([
    "packages/core/src/task-store/audit-ops.ts",
    "packages/dashboard/src/__tests__/task-log-route.pg.test.ts",
    "scripts/run-fusi013-regression.mjs",
  ].map((file) => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")]));
  stage = "lifecycle-import";
  const { EmbeddedPostgresLifecycle } = await tsImport("../packages/core/src/postgres/embedded-lifecycle.ts", import.meta.url);
  const dataDir = join(directory, "database");
  const startupBudget = Math.floor(deadline - performance.now());
  if (startupBudget <= 0) throw new Error("private startup work deadline exceeded");
  const lifecycle = new EmbeddedPostgresLifecycle({ dataDir, onLog() {}, onError() { lifecycleFailed = true; }, startTimeoutMs: Math.min(90_000, startupBudget) });
  stage = "postgres-lifecycle";
  const result = await withOwnedPostgres(lifecycle, async (connection) => {
    const url = new URL(connection.runtimeUrl);
    url.pathname = "";
    const lines = readFileSync(join(dataDir, "postmaster.pid"), "utf8").trim().split(/\r?\n/);
    identity = { pid: Number(lines[0]), port: Number(lines[3]) };
    if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || identity.port !== Number(url.port) || resolve(lines[1]).toLowerCase() !== resolve(dataDir).toLowerCase()) throw new Error("private PostgreSQL identity unproven");
    const base = url.toString().replace(/\/$/, "");
    const baseline = await runFocusedTest(join(baselineRoot, "packages", "dashboard"), "src/__tests__/task-log-route.pg.test.ts", base, "baseline");
    receipt.baseline = { source: baselineRevision, exit: baseline.exit.code, ...reportCounts(baseline.report) };
    const baselineRed = baseline.exit.code !== 0 && (baseline.report?.numPassedTests ?? 0) > 0 && (baseline.report?.numFailedTests ?? 0) > 0 && (baseline.report?.numPendingTests ?? 0) === 0 && hasBaseline404Failure(baseline.report);
    if (!baselineRed) return 1;
    const candidate = await runFocusedTest(join(root, "packages", "dashboard"), "src/__tests__/task-log-route.pg.test.ts", base, "candidate");
    receipt.candidate = { source: candidateRevision, exit: candidate.exit.code, ...reportCounts(candidate.report) };
    return pgResultPassed(candidate.exit, candidate.report) ? 0 : 1;
  }, async () => {
    if (!identity) throw new Error("private PostgreSQL shutdown identity unproven");
    await requireStopped(identity, { pidAbsent: processAbsent, portAbsent: endpointAbsent });
    if (lifecycleFailed) throw new Error("private PostgreSQL lifecycle reported failure");
    receipt.shutdownVerified = true;
  });
  exitCode = result;
} catch {
  exitCode = 1;
} finally {
  finishIsolatedRegression({ runner: "fusi013", stage, ...receipt, outcome: exitCode === 0 ? "passed" : "failed" }, exitCode);
}
