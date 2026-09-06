import { resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
const { superviseSpawn } = await tsImport('../../packages/core/src/process/process-supervisor.ts', import.meta.url);

// FNXC:TaskLogRegression 2026-09-06-13:47: Keep the work deadline inside the
// caller's gate so its finally block can stop PostgreSQL before an outer kill.
export async function runRegressionCommand(command, args, { deadline, ...options }) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) return { code: 124, signal: null, output: '' };
  const windows = process.platform === 'win32';
  const child = superviseSpawn(windows ? 'powershell.exe' : command, windows ? [
    '-NoProfile', '-NonInteractive', '-File', resolve(import.meta.dirname, 'run-owned-windows-command.ps1'),
    '-Executable', command, '-ArgumentsBase64', Buffer.from(JSON.stringify(args)).toString('base64'), '-TimeoutMs', String(remaining),
  ] : args, {
    ...options, windowsHide: true, shell: false,
    // Windows job owns its deadline; don't kill its parent before it proves empty.
    maxLifetimeMs: windows ? 0 : remaining,
  });
  let output = '';
  child.child.stdout?.on('data', chunk => { output += chunk; });
  const result = await child.waitExit();
  return { ...result, output };
}
