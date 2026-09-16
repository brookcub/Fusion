from pathlib import Path

native = Path("packages/engine/src/sandbox/native.ts")
text = native.read_text(encoding="utf-8")

anchor = 'import { superviseSpawn } from "@fusion/core";\n\n'
replacement = anchor + 'import { runWindowsOwnedCommand } from "./windows-owned-command.js";\n\n'
if text.count(anchor) != 1:
    raise SystemExit("F03 native import anchor drifted")
text = text.replace(anchor, replacement, 1)

run_anchor = '  async run(command: string, options: SandboxRunOptions): Promise<SandboxRunResult> {\n'
run_replacement = run_anchor + '    if (process.platform === "win32") return runWindowsOwnedCommand(command, options);\n'
if text.count(run_anchor) != 1:
    raise SystemExit("F03 run anchor drifted")
text = text.replace(run_anchor, run_replacement, 1)

stream_anchor = '''    if (options.signal?.aborted) {
      return {
        outcome: "aborted",
        phase: "pre-start",
        stdout: "",
        stderr: "",
      };
    }

    return await new Promise((resolve) => {
'''
stream_replacement = '''    if (options.signal?.aborted) {
      return {
        outcome: "aborted",
        phase: "pre-start",
        stdout: "",
        stderr: "",
      };
    }

    if (process.platform === "win32") {
      const result = await runWindowsOwnedCommand(command, {
        cwd: options.cwd,
        timeoutMs: options.timeout,
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0", ...options.env },
        onOutput: options.onOutput,
      }, false);
      const output = { stdout: result.stdout, stderr: result.stderr };
      if (result.spawnError) return { ...output, outcome: "spawn-error", error: result.spawnError };
      if (result.aborted) return { ...output, outcome: "aborted", phase: "mid-flight" };
      if (result.timedOut) return { ...output, outcome: "timeout", timeoutMs: options.timeout };
      if (result.exitCode === 0) return { ...output, outcome: "success", bufferOverflow: result.bufferExceeded };
      return { ...output, outcome: "non-zero-exit", exitCode: result.exitCode, signal: result.signal };
    }

    return await new Promise((resolve) => {
'''
if text.count(stream_anchor) != 1:
    raise SystemExit("F03 streaming anchor drifted")
text = text.replace(stream_anchor, stream_replacement, 1)
native.write_text(text, encoding="utf-8")

types = Path("packages/engine/src/sandbox/types.ts")
t = types.read_text(encoding="utf-8")
type_anchor = '''  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}
'''
type_replacement = '''  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Optional best-effort activity observation, not a completion verdict. */
  onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
}
'''
if t.count(type_anchor) != 1:
    raise SystemExit("F03 types anchor drifted")
t = t.replace(type_anchor, type_replacement, 1)
types.write_text(t, encoding="utf-8")
