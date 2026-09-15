import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

import { superviseSpawn } from "@fusion/core";

import source from "./windows-owned-command-source.js";
import type { SandboxRunOptions, SandboxRunResult } from "./types.js";

const SETUP_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 5_000;

// FNXC:WindowsContainment 2026-09-09-12:37: The helper quotes CRT argv, not cmd.exe syntax. Node owns shell quoting
// inside the already-assigned Job, including the shell's detached descendants.
const BRIDGE = `const {spawn}=require('node:child_process');
const {command,shell}=JSON.parse(Buffer.from(process.argv[1],'base64').toString('utf8'));
const child=spawn(command,[],{shell,stdio:'inherit',windowsHide:true});
child.on('error',()=>process.exit(126));
child.on('exit',(code)=>process.exit(code===null?125:code));`;

export interface WindowsOwnedCommandResult extends SandboxRunResult {
  aborted: boolean;
}

/** A command result is authoritative only after the helper proves its Job empty. */
export async function runWindowsOwnedCommand(
  command: string,
  options: SandboxRunOptions & { onOutput?: (stream: "stdout" | "stderr", chunk: string) => void },
  stopOnOverflow = true,
): Promise<WindowsOwnedCommandResult> {
  const empty = { stdout: "", stderr: "", exitCode: null, signal: null, timedOut: false, bufferExceeded: false, aborted: false };
  if (options.signal?.aborted) return { ...empty, aborted: true };
  let directory: string;
  try {
    directory = await mkdtemp(join(tmpdir(), "fusion-owned-command-"));
    await writeFile(join(directory, "owner.ps1"), source, "utf8");
  } catch {
    return { ...empty, spawnError: new Error("Windows command owner could not be prepared") };
  }
  const cancelFile = join(directory, "cancel");
  const outcomeFile = join(directory, "outcome.json");
  const readyFile = join(directory, "ready");
  if (options.signal?.aborted) {
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return { ...empty, aborted: true };
  }
  const args = ["-e", BRIDGE, Buffer.from(JSON.stringify({ command, shell: options.shell ?? true })).toString("base64")];
  const startedAt = performance.now();
  let supervised: ReturnType<typeof superviseSpawn>;
  try {
    supervised = superviseSpawn("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", join(directory, "owner.ps1"), "-Executable", process.execPath,
      "-ArgumentsBase64", Buffer.from(JSON.stringify(args)).toString("base64"),
      "-TimeoutMs", String(options.timeoutMs > 0 ? options.timeoutMs : -1),
      "-CancelFile", cancelFile, "-OutcomeFile", outcomeFile, "-ReadyFile", readyFile,
    ], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // This adapter owns setup, execution and cleanup deadlines independently.
      maxLifetimeMs: 0,
    });
  } catch {
    return { ...empty, spawnError: new Error(`Windows command owner launch failed; receipt: ${directory}`) };
  }
  const child = supervised.child;
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let bufferExceeded = false;
  let aborted = false;
  let closed = false;
  let launchFailed = false;
  let helperCode: number | null = null;
  let readyAt: number | undefined;
  let cancelAt: number | undefined;
  let cancellationWrite: Promise<void> | undefined;
  let cleanupFailure = false;
  const cancel = (): void => {
    if (cancelAt !== undefined) return;
    cancelAt = performance.now();
    cancellationWrite = writeFile(cancelFile, "cancel", "utf8").catch(() => { cleanupFailure = true; });
  };
  const onAbort = (): void => { aborted = true; cancel(); };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const append = (chunks: Buffer[], chunk: Buffer, used: number): number => {
    const remaining = Math.max(0, options.maxBuffer - used);
    if (chunk.length > remaining) {
      bufferExceeded = true;
      if (stopOnOverflow) cancel();
    }
    if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
    return used + Math.min(chunk.length, remaining);
  };
  const emit = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    try { void Promise.resolve(options.onOutput?.(stream, chunk.toString(options.encoding ?? "utf8"))).catch(() => undefined); } catch { /* Observation is not ownership. */ }
  };
  child.stdout?.on("data", (chunk: Buffer) => { stdoutBytes = append(stdout, chunk, stdoutBytes); emit("stdout", chunk); });
  child.stderr?.on("data", (chunk: Buffer) => { stderrBytes = append(stderr, chunk, stderrBytes); emit("stderr", chunk); });
  const closedPromise = new Promise<void>((resolve) => {
    child.once("error", () => { launchFailed = true; resolve(); });
    child.once("close", (code) => { closed = true; helperCode = code; resolve(); });
  });
  try {
    while (!closed && !launchFailed) {
      if (readyAt === undefined) {
        try { await access(readyFile); readyAt = performance.now(); } catch { /* Not ready yet. */ }
      }
      const now = performance.now();
      const setupExpired = readyAt === undefined && now - startedAt >= SETUP_TIMEOUT_MS;
      const commandExpired = readyAt !== undefined && options.timeoutMs > 0
        && now - readyAt >= options.timeoutMs + CLEANUP_TIMEOUT_MS;
      const cancelExpired = cancelAt !== undefined && now - cancelAt >= CLEANUP_TIMEOUT_MS;
      if (setupExpired || commandExpired || cancelExpired || cleanupFailure) {
        cleanupFailure = true;
        supervised.kill("SIGKILL");
        await Promise.race([closedPromise, delay(1_000)]);
        break;
      }
      await Promise.race([closedPromise, delay(50)]);
    }
    await cancellationWrite;
    const result = {
      ...empty,
      stdout: Buffer.concat(stdout).toString(options.encoding ?? "utf8"),
      stderr: Buffer.concat(stderr).toString(options.encoding ?? "utf8"),
      bufferExceeded,
      aborted,
    };
    let receipt: { outcome?: unknown; jobEmpty?: unknown; exitCode?: unknown } | undefined;
    try { receipt = JSON.parse(await readFile(outcomeFile, "utf8")); } catch { /* Missing means unproven. */ }
    if (cleanupFailure || launchFailed || !closed || !receipt || receipt.jobEmpty !== true
      || !["exit", "timeout", "cancelled"].includes(String(receipt.outcome))
      || !Number.isInteger(receipt.exitCode) || helperCode !== receipt.exitCode
      || (receipt.outcome === "timeout" && receipt.exitCode !== 124)
      || (receipt.outcome === "cancelled" && receipt.exitCode !== 125)) {
      return { ...result, spawnError: new Error(`Windows command cleanup unproven; receipt: ${directory}`) };
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    return {
      ...result,
      exitCode: receipt.outcome === "exit" && !aborted && !(stopOnOverflow && bufferExceeded) ? Number(receipt.exitCode) : null,
      timedOut: receipt.outcome === "timeout",
      aborted: aborted || (receipt.outcome === "cancelled" && !bufferExceeded),
    };
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    if (!closed) supervised.kill("SIGKILL");
    // Do not wait forever for leaked inherited pipes after a failed helper.
    child.stdout?.destroy();
    child.stderr?.destroy();
  }
}
