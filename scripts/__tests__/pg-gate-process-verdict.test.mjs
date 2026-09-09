import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const dependency = pathToFileURL(require.resolve('embedded-postgres')).href;
const helper = new URL('../run-isolated-pg-gate.mjs', import.meta.url).href;
const cwd = fileURLToPath(new URL('../../', import.meta.url));
for (const code of [0, 1, 7]) {
  test(`actual embedded-postgres exit hook cannot replace gate verdict ${code}`, () => {
    const source = `await import(${JSON.stringify(dependency)});
      const {finishGateProcess}=await import(${JSON.stringify(helper)});
      console.log('receipt-flushed'); await finishGateProcess(${code});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source],
      { cwd, encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, code);
    assert.match(result.stdout, /receipt-flushed/);
  });
}
