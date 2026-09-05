import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('capacity gate enumerates tracked sources without shell-dependent quoting', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion capacity spaces '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'packages/core/src'), { recursive: true });
  await writeFile(join(root, 'packages/core/src/example.ts'), 'export const example = 1;\n');
  for (const args of [['init'], ['add', 'packages/core/src/example.ts']]) {
    const git = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(git.status, 0, git.stderr);
  }
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../check-capacity-pool-id.mjs', import.meta.url))], {
    cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /1 files inspected/);
});

test('static gate CLI executes and propagates validator failures from a spaced checkout', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fusion gate spaces '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await copyFile(new URL('../run-static-gate-checks.mjs', import.meta.url), join(root, 'scripts/run-static-gate-checks.mjs'));
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {
    'test:gate:static': 'node scripts/check-fixture.mjs',
  } }));
  await writeFile(join(root, 'scripts/check-fixture.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'executed'); process.exit(7);\n");
  const result = spawnSync(process.execPath, [join(root, 'scripts/run-static-gate-checks.mjs')], {
    cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, 'a no-op CLI must not pass the merge gate');
  assert.equal(await readFile(join(root, 'ran.txt'), 'utf8'), 'executed');
  assert.match(result.stderr, /validator failed/);
});
import { URL } from 'node:url';
