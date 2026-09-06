import assert from 'node:assert/strict';
import { createConnection } from 'node:net';
import { performance } from 'node:perf_hooks';
import test from 'node:test';
import { runRegressionCommand } from '../lib/run-regression-command.mjs';

test('returns exact command failure with a path and argument containing spaces', async () => {
  const result = await runRegressionCommand(process.execPath, ['-e', 'console.log(process.argv[1]);process.exit(7)', 'argument with "quotes" and spaces\\'], {
    deadline: performance.now() + 10000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.code, 7);
  assert.equal(result.output.trim(), 'argument with "quotes" and spaces\\');
});

test('deadline reaps a detached descendant listener before returning', async () => {
  const descendant = `const net=require('node:net');const server=net.createServer();server.listen(0,'127.0.0.1',()=>console.log(JSON.stringify({pid:process.pid,port:server.address().port})));`;
  const parent = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:process.platform==='win32',windowsHide:true,stdio:['ignore','pipe','ignore']});child.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  const result = await runRegressionCommand(process.execPath, ['-e', parent], {
    deadline: performance.now() + 2500, stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.notEqual(result.code, 0);
  const identity = JSON.parse(result.output.trim());
  assert.throws(() => process.kill(identity.pid, 0), { code: 'ESRCH' });
  const absent = await new Promise(resolve => {
    const socket = createConnection({host:'127.0.0.1',port:identity.port});
    const finish = value => { socket.destroy(); resolve(value); };
    socket.on('connect', () => finish(false));
    socket.on('error', error => finish(error.code === 'ECONNREFUSED'));
    socket.setTimeout(500, () => finish(false));
  });
  assert.equal(absent, true);
});
