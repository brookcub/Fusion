import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const require = createRequire(resolve(root, 'packages/core/package.json'));
const postgres = pathToFileURL(require.resolve('embedded-postgres')).href;
const helper = pathToFileURL(resolve(root, 'scripts/lib/finish-isolated-regression.mjs')).href;

for (const code of [0, 1]) {
  test(`preserves native exit ${code} despite the actual embedded-postgres exit hook`, () => {
    const script = `await import(${JSON.stringify(postgres)});
      const { finishIsolatedRegression } = await import(${JSON.stringify(helper)});
      finishIsolatedRegression({ outcome: ${JSON.stringify(code === 0 ? 'passed' : 'failed')} }, ${code});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root, encoding: 'utf8', windowsHide: true, shell: false, timeout: 15000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, code);
    assert.deepEqual(JSON.parse(result.stdout), { outcome: code === 0 ? 'passed' : 'failed' });
  });
}
