// FNXC:RecoverySmoke 2026-09-05-08:47: read-only persisted runtime census,
// explicitly confined to a disposable Task System development instance.
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { URL } from 'node:url';
import { DEFAULT_EMBEDDED_USER, DEFAULT_EMBEDDED_PASSWORD, DEFAULT_EMBEDDED_DATABASE } from '../packages/core/dist/postgres/embedded-lifecycle.js';
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
const postgres = require('postgres');
const configPath = realpathSync(process.argv[2]);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const root = resolve(configPath, '..');
const runtime = realpathSync(config.runtimeDirectory);
const rel = relative(root, runtime);
if (config.instanceRole !== 'development' || rel.startsWith('..') || isAbsolute(rel) || Object.keys(config.projects).join() !== 'smoke') throw new Error('isolated smoke instance required');
const data = join(runtime, 'home/.fusion/embedded-postgres/default');
const lock = readFileSync(join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/);
if (realpathSync(lock[1]) !== realpathSync(data)) throw new Error('PostgreSQL directory identity mismatch');
const port = Number(lock[3]);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('invalid private PostgreSQL port');
const client = postgres({ host: '127.0.0.1', port, username: DEFAULT_EMBEDDED_USER, password: DEFAULT_EMBEDDED_PASSWORD,
  database: DEFAULT_EMBEDDED_DATABASE, max: 1, connect_timeout: 5, connection: { statement_timeout: 5000, default_transaction_read_only: 'on' }, onnotice: () => {} });
try {
  const tables = await client`SELECT table_schema, table_name FROM information_schema.tables WHERE table_name IN ('workflow_work_items','workflow_run_branches','workflow_run_step_instances','ai_sessions') AND table_schema NOT IN ('information_schema','pg_catalog') ORDER BY 1,2`;
  const result = [];
  for (const table of tables) {
    const field = table.table_name === 'workflow_work_items' ? 'state' : 'status';
    if (!/^[a-z0-9_]+$/.test(table.table_schema)) throw new Error('unexpected schema identifier');
    const counts = await client.unsafe(`SELECT "${field}" AS state, count(*)::int AS count FROM "${table.table_schema}"."${table.table_name}" GROUP BY "${field}" ORDER BY 1`);
    result.push({ schema: table.table_schema, table: table.table_name, counts });
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ failed: true, type: error.name, code: error.code ?? null }));
  process.exitCode = 1;
} finally { await client.end({ timeout: 5 }); }
