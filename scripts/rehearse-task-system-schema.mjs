// FNXC:RecoverySchema 2026-09-05-08:50: run only the standard Fusion schema
// lifecycle against a verified private clone. No TaskStore, engines or plugins load.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, realpathSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, URL } from 'node:url';
import { EmbeddedPostgresLifecycle } from '../packages/core/dist/postgres/embedded-lifecycle.js';
// FNXC:RecoverySchema 2026-09-05-09:30: source tsc output does not copy SQL assets.
process.env.FUSION_MIGRATIONS_DIR = fileURLToPath(new URL('../packages/core/src/postgres/migrations/', import.meta.url));
const { applySchemaBaseline } = await import('../packages/core/dist/postgres/schema-applier.js');
const { DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS } = await import('../packages/core/dist/postgres/plugin-schema-hook.js');
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const postgres = require('postgres');
const { drizzle } = require('drizzle-orm/postgres-js');
const root = realpathSync(process.argv[2]);
const workspace = realpathSync('C:/LynCo Workspace/Fusion Recovery Operations');
const rel = relative(workspace, root);
if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('private rehearsal root required');
const receipt = JSON.parse(readFileSync(join(root, 'extraction.json'), 'utf8'));
const dataDir = realpathSync(receipt.databaseDirectory);
if (dataDir !== join(root, 'database') || receipt.externalConfigurationAbsent !== true) throw new Error('verified isolated extraction required');
process.env.HOME = join(root, 'home'); process.env.USERPROFILE = process.env.HOME;
const lifecycle = new EmbeddedPostgresLifecycle({ dataDir, startTimeoutMs: 90000, onLog: () => {}, onError: () => {} });
let client;
let stage = 'start';
let failed = false;
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', args, { cwd: sourceRoot, encoding: 'utf8', windowsHide: true }).trim();
const fileMetadata = path => {
  const bytes = readFileSync(path);
  return { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
};
try {
  const connection = await lifecycle.start();
  stage = 'census-before';
  client = postgres(connection.runtimeUrl, { max: 1, connect_timeout: 5, connection: { statement_timeout: 60000 }, onnotice: () => {} });
  const census = async () => {
    const tables = await client`SELECT table_schema FROM information_schema.tables WHERE table_name = 'tasks' AND table_schema NOT IN ('information_schema','pg_catalog') ORDER BY 1`;
    const output = [];
    for (const { table_schema: schema } of tables) {
      if (!/^[a-z0-9_]+$/.test(schema)) throw new Error('unexpected schema identifier');
      const rows = await client.unsafe(`SELECT * FROM "${schema}".tasks ORDER BY id`);
      output.push({ schema, tasks: rows.map(row => Object.fromEntries(['id','project_id','title','description','column','status','paused','user_paused','steps'].filter(key => key in row).map(key => [key,row[key]]))) });
    }
    return output;
  };
  const before = await census();
  writeFileSync(join(root, 'task-list-before.json'), JSON.stringify(before, null, 2));
  stage = 'schema-application';
  const result = await applySchemaBaseline(drizzle(client));
  const after = await census();
  stage = 'comparison';
  writeFileSync(join(root, 'task-list-after.json'), JSON.stringify(after, null, 2));
  const record = { beforeCounts: before.map(x => ({ schema: x.schema, count: x.tasks.length })),
    afterCounts: after.map(x => ({ schema: x.schema, count: x.tasks.length })),
    taskFingerprintBefore: hash(before), taskFingerprintAfter: hash(after), preserved: hash(before) === hash(after),
    pluginHooksRun: result.pluginHooksRun, schemaHookIds: DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS.map(x => x.pluginId),
    runtimePluginsLoaded: false, sourceSnapshotSha256: receipt.archiveSha256,
    preUpgradeSnapshotSha256: fileMetadata(join(root, 'before-upgrade.snapshot')).sha256,
    sourceCommit: git('rev-parse', 'HEAD'), sourceClean: git('status', '--porcelain') === '',
    migrationFiles: Object.fromEntries(readdirSync(process.env.FUSION_MIGRATIONS_DIR).filter(x => x.endsWith('.sql')).sort()
      .map(name => [name, fileMetadata(join(process.env.FUSION_MIGRATIONS_DIR, name))])) };
  writeFileSync(join(root, 'migration-result.json'), JSON.stringify(record, null, 2));
  if (!record.preserved || record.pluginHooksRun !== DEFAULT_PLUGIN_SCHEMA_INIT_HOOKS.length)
    throw new Error('migration did not preserve task census or run the standard schema hooks');
  console.log(JSON.stringify(record));
} catch (error) {
  failed = true;
  writeFileSync(join(root, 'failure-private.json'), JSON.stringify({ stage, message: error.message, stack: error.stack }));
  console.error(JSON.stringify({ failed: true, stage, type: error.name, code: error.code ?? null }));
  process.exitCode = 1;
} finally {
  if (client) await client.end({ timeout: 5 });
  try { await lifecycle.stop(); }
  catch (error) { failed = true; console.error(JSON.stringify({ stopFailed: true, type: error.name })); process.exitCode = 1; }
}
process.exit(failed ? 1 : 0);
