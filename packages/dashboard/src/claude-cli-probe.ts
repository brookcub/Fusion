/**
 * Probe for the locally-installed Claude CLI binary.
 *
 * Used by GET /api/providers/claude-cli/status to power the "Anthropic —
 * via Claude CLI" provider card. The card shows `authenticated=true` only
 * when the binary is on PATH *and* the user has flipped on `useClaudeCli`.
 *
 * Intentional design choices:
 *
 * - No caching. The user's PATH can change between requests (nvm switches,
 *   fresh terminal, etc.) — we'd rather pay one `spawn()` per poll than
 *   serve a stale "claude not installed" response. Claude's `--version`
 *   flag exits in ~40ms, so cost is negligible.
 *
 * - Short timeout. A misbehaving PATH lookup or `claude` shim must not block
 *   the HTTP request beyond the single probe budget.
 *
 * - No authorization. We never shell-interpolate PATH or user input.
 *   We spawn `claude --version` directly with argv, no shell.
 */

import { spawn, type ChildProcess } from "node:child_process";

/** Result shape returned to the dashboard status endpoint. */
export interface ClaudeCliBinaryStatus {
  /** True if the `claude` binary was found on PATH and ran to completion. */
  available: boolean;
  /** Trimmed stdout from `claude --version`, if available. */
  version?: string;
  /** Absolute path, if we could resolve it via `which`. */
  binaryPath?: string;
  /** Human-readable failure reason when `available === false`. */
  reason?: string;
  /** Wall-clock duration of the probe, useful for debugging slow paths. */
  probeDurationMs: number;
}

/** Default probe timeout. Claude's --version is fast; 2s is generous. */
const PROBE_TIMEOUT_MS = 2000;

function safeKill(child: ChildProcess | undefined): void {
  if (!child) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Process already gone — nothing to do.
  }
}

/**
 * Spawn `claude --version` and return a structured status result.
 *
 * Never throws — any failure is captured as `available: false` with a reason
 * so the caller (an HTTP handler) can render the provider card without
 * try/catch.
 */
export async function probeClaudeCli(
  options: { timeoutMs?: number } = {},
): Promise<ClaudeCliBinaryStatus> {
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const deadline = startedAt + Math.max(0, timeoutMs);
  const elapsed = (): number => Date.now() - startedAt;
  const timeoutResult = (binaryPath?: string): ClaudeCliBinaryStatus => ({
    available: false,
    binaryPath,
    reason: `Probe timed out after ${timeoutMs}ms`,
    probeDurationMs: elapsed(),
  });

  try {
    const binaryPath = await tryResolveBinaryPath(
      "claude",
      Math.max(0, deadline - Date.now()),
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return timeoutResult(binaryPath);

    return await new Promise<ClaudeCliBinaryStatus>((resolvePromise) => {
      let settled = false;
      let child: ChildProcess | undefined;
      const finish = (
        result: Omit<ClaudeCliBinaryStatus, "probeDurationMs">,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ ...result, probeDurationMs: elapsed() });
      };
      const timer = setTimeout(() => {
        safeKill(child);
        finish({
          available: false,
          binaryPath,
          reason: `Probe timed out after ${timeoutMs}ms`,
        });
      }, remainingMs);

      try {
        child = spawn(binaryPath ?? "claude", ["--version"], {
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        finish({ available: false, binaryPath, reason: err.message });
        return;
      }

      if (!child || typeof child.on !== "function") {
        finish({
          available: false,
          binaryPath,
          reason: "Failed to launch `claude --version`",
        });
        return;
      }

      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString("utf-8");
      });

      child.on("error", (err) => {
        const isNotFound = (err as NodeJS.ErrnoException).code === "ENOENT";
        finish({
          available: false,
          binaryPath,
          reason: isNotFound ? "`claude` not found on PATH" : err.message,
        });
      });

      child.on("close", (code) => {
        if (code === 0) {
          finish({
            available: true,
            version: stdout.trim() || undefined,
            binaryPath,
          });
        } else {
          finish({
            available: false,
            binaryPath,
            reason:
              stderr.trim() ||
              `claude --version exited with code ${String(code)}`,
          });
        }
      });
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { available: false, reason: err.message, probeDurationMs: elapsed() };
  }
}

/**
 * Best-effort `which claude`. Failure or timeout here never rejects the probe.
 * The version spawn remains the authority when budget remains.
 */
async function tryResolveBinaryPath(
  binary: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (timeoutMs <= 0) return undefined;
  return new Promise((resolvePromise) => {
    const which = process.platform === "win32" ? "where" : "which";
    let settled = false;
    let child: ChildProcess | undefined;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const timer = setTimeout(() => {
      safeKill(child);
      finish(undefined);
    }, timeoutMs);

    try {
      child = spawn(which, [binary], {
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      finish(undefined);
      return;
    }
    if (!child || typeof child.on !== "function") {
      finish(undefined);
      return;
    }

    let out = "";
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString("utf-8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", (code) => {
      if (code === 0) {
        const first = out.trim().split(/\r?\n/)[0];
        finish(first?.length ? first : undefined);
      } else {
        finish(undefined);
      }
    });
  });
}
