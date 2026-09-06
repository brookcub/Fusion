#!/usr/bin/env node
/* FNXC:TaskLogRegression 2026-09-06-08:16: Own a private PostgreSQL run so the task-log 404 contract is proven without caller database state. */
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";
import { gateLanes, runChild, vitestInvocation } from "./run-merge-gate.mjs";
import { endpointAbsent, processAbsent, requireStopped, withOwnedPostgres } from "./run-isolated-pg-gate.mjs";

const root = resolve(import.meta.dirname, "..");
const dir = mkdtempSync(join(tmpdir(), "fusion fusi013 "));
const home = join(dir, "home");
mkdirSync(home);
for (const key of ["DATABASE_URL", "PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE"]) delete process.env[key];
const { EmbeddedPostgresLifecycle } = await tsImport("../packages/core/src/postgres/embedded-lifecycle.ts", import.meta.url);
const lifecycle = new EmbeddedPostgresLifecycle({ dataDir: join(dir, "database"), onLog() {}, onError() { throw new Error("postgres lifecycle failure"); }, startTimeoutMs: 90000 });
let identity;
const result = await withOwnedPostgres(lifecycle, async (connection) => {
  const url = new URL(connection.runtimeUrl); url.pathname = "";
  const pid = Number(readFileSync(join(dir, "database", "postmaster.pid"), "utf8").split(/\r?\n/)[0]);
  identity = { pid, port: Number(url.port) };
  const lane = gateLanes.find((candidate) => candidate.postgres);
  if (!lane) throw new Error("PostgreSQL test lane unavailable");
  const invocation = vitestInvocation(lane);
  const args = [...invocation.args.filter((arg) => !arg.includes("--reporter")), "packages/core/src/__tests__/postgres/task-log-route.pg.test.ts", "--reporter=dot"];
  const exit = await runChild(args, { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, FUSION_PG_TEST_URL_BASE: url.toString().replace(/\/$/, ""), FUSION_PG_TEST_SKIP: "0", FUSION_PG_TEST_SETUP_PARTICIPANT: "1" } });
  return exit.code;
}, async () => { await requireStopped(identity, { pidAbsent: processAbsent, portAbsent: endpointAbsent }); });
console.log(JSON.stringify({ runner: "fusi013", exitCode: result, tests: "nonempty", shutdownVerified: true }));
process.exitCode = result;
