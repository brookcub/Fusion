// FNXC:RecoveryPgGate 2026-09-05-09:50: native Windows gate on an empty private
// cluster. No daemon, task engines, plugins, production data or provider auth.
import { createRequire } from 'node:module';
import { mkdirSync, existsSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import { EmbeddedPostgresLifecycle } from '../packages/core/dist/postgres/embedded-lifecycle.js';
const root = resolve(process.argv[2]);
const base = resolve('C:/LynCo Workspace/Fusion Recovery Operations');
const rel = relative(base, root);
if (!rel || rel.startsWith('..') || isAbsolute(rel) || existsSync(root)) throw new Error('new private gate directory required');
mkdirSync(root, { recursive: true });
process.env.HOME = join(root, 'home'); process.env.USERPROFILE = process.env.HOME;
const lifecycle = new EmbeddedPostgresLifecycle({ dataDir: join(root, 'database'), onLog() {}, onError() {}, startTimeoutMs: 90000 });
const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
let failed = true;
try {
  const connection = await lifecycle.start();
  const url = new URL(connection.runtimeUrl); url.pathname = '';
  const output = join(root, 'vitest.json'); const log = openSync(join(root, 'gate-private.log'), 'wx');
  let exit;
  try {
    const child = spawn(process.execPath, [join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run', '--config', 'vitest.pg.config.ts',
      'src/__tests__/postgres/handoff-to-review-atomicity.pg.test.ts',
      'src/__tests__/postgres/task-lifecycle-e2e.pg.test.ts', '--pool=forks', '--maxWorkers=1', '--reporter=json', '--outputFile=' + output],
      { cwd: fileURLToPath(new URL('../packages/core/', import.meta.url)), windowsHide: true,
        stdio: ['ignore', log, log], env: { ...process.env, FUSION_PG_TEST_URL_BASE: url.toString().replace(/\/$/, ''),
          FUSION_PG_TEST_SKIP: '0', FUSION_PG_TEST_SETUP_PARTICIPANT: '1' } });
    exit = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  } finally { closeSync(log); }
  const result = JSON.parse(readFileSync(output, 'utf8'));
  const receipt = { ...exit, passed: result.numPassedTests, failed: result.numFailedTests,
    skipped: result.numPendingTests, success: result.success };
  writeFileSync(join(root, 'result.json'), JSON.stringify(receipt));
  console.log(JSON.stringify(receipt));
  failed = exit.code !== 0 || !result.success || result.numPassedTests === 0 || result.numPendingTests !== 0;
} catch (error) {
  writeFileSync(join(root, 'failure-private.json'), JSON.stringify({ message: error.message, stack: error.stack }));
  console.error(JSON.stringify({ failed: true, type: error.name, code: error.code ?? null }));
} finally { await lifecycle.stop(); }
process.exit(failed ? 1 : 0);
