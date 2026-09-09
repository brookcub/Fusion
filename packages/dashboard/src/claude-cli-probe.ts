/**
 * Native Claude binary availability and local login are separate facts.
 * Path lookup, version and auth share one deadline; no model request is made.
 */
import { spawn } from "node:child_process";
// The adapter owns native child auth. The pure JS helper is inlined by the
// dashboard/CLI bundler and ships in the adapter's existing raw source copy.
import { buildNativeClaudeEnv } from "../../pi-claude-cli/src/native-auth-env.js";

export interface ClaudeCliBinaryStatus {
  available: boolean;
  /** Only literal loggedIn:true from a successful native auth probe is true. */
  authenticated?: boolean;
  version?: string;
  binaryPath?: string;
  /** Safe diagnostic; auth payloads and child stderr are never returned. */
  reason?: string;
  probeDurationMs: number;
}

const PROBE_TIMEOUT_MS = 2000;
const MAX_OUTPUT_BYTES = 16_384;

type CommandResult = { ok: boolean; stdout: string; reason?: string };

function runProbe(command: string, args: string[], deadline: number, env: NodeJS.ProcessEnv): Promise<CommandResult> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.resolve({ ok: false, stdout: "", reason: "Probe timed out" });
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let outputBytes = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const failAndKill = (reason: string) => {
      finish({ ok: false, stdout: "", reason });
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env });
    } catch {
      finish({ ok: false, stdout: "", reason: "Probe could not start" });
      return;
    }
    timer = setTimeout(() => failAndKill("Probe timed out"), remaining);
    const receive = (chunk: Buffer | string, isStdout: boolean) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += buffer.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        failAndKill("Probe output exceeded limit");
        return;
      }
      if (isStdout) stdout += buffer.toString("utf8");
    };
    child.stdout?.on("data", (chunk) => receive(chunk, true));
    child.stderr?.on("data", (chunk) => receive(chunk, false));
    child.on("error", () => finish({ ok: false, stdout: "", reason: "Probe process failed" }));
    child.on("close", (code) => finish(code === 0
      ? { ok: true, stdout }
      : { ok: false, stdout: "", reason: "Probe exited unsuccessfully" }));
  });
}

/** Never throws for CLI failures; absent or unknown login fails closed. */
export async function probeClaudeCli(options: { timeoutMs?: number } = {}): Promise<ClaudeCliBinaryStatus> {
  const startedAt = Date.now();
  const requested = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requested) ? Math.max(1, Math.min(requested, PROBE_TIMEOUT_MS)) : PROBE_TIMEOUT_MS;
  const deadline = startedAt + timeoutMs;
  const env = buildNativeClaudeEnv();
  const result: ClaudeCliBinaryStatus = { available: false, authenticated: false, probeDurationMs: 0 };
  try {
    const path = await runProbe(process.platform === "win32" ? "where" : "which", ["claude"], deadline, env);
    result.binaryPath = path.ok ? path.stdout.trim().split(/\r?\n/)[0] || undefined : undefined;
    const version = await runProbe(result.binaryPath ?? "claude", ["--version"], deadline, env);
    if (!version.ok) {
      result.reason = version.reason;
      return result;
    }
    result.available = true;
    result.version = version.stdout.trim() || undefined;
    const auth = await runProbe(result.binaryPath ?? "claude", ["auth", "status", "--json"], deadline, env);
    if (!auth.ok) {
      result.reason = auth.reason;
      return result;
    }
    let status: unknown;
    try { status = JSON.parse(auth.stdout); } catch {
      result.reason = "Claude CLI auth status was malformed";
      return result;
    }
    result.authenticated = status !== null && typeof status === "object" &&
      !Array.isArray(status) && (status as { loggedIn?: unknown }).loggedIn === true;
    if (!result.authenticated) result.reason = "Claude CLI login was not confirmed; run claude auth login";
    return result;
  } catch {
    result.reason = "Claude CLI probe failed";
    return result;
  } finally {
    result.probeDurationMs = Date.now() - startedAt;
    if (result.reason === "Probe timed out") result.reason = `Probe timed out after ${timeoutMs}ms`;
  }
}
