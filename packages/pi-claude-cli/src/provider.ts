/**
 * Provider orchestration for bridging pi requests to the Claude CLI subprocess.
 *
 * streamViaCli is the core function that:
 * 1. Builds the prompt from conversation context
 * 2. Spawns a Claude CLI subprocess with correct flags
 * 3. Writes the user message to stdin as NDJSON
 * 4. Reads stdout line-by-line, parsing NDJSON
 * 5. Routes stream events through the event bridge to pi's stream
 * 6. Handles result/error messages and cleans up the subprocess
 * 7. Implements break-early: kills subprocess at message_stop when
 *    built-in or custom-tools MCP tool_use blocks are seen
 * 8. Hardened lifecycle: inactivity timeout, subprocess exit handler,
 *    streamEnded guard, abort via SIGKILL, process registry
 */

import { createInterface } from "node:readline";
import {
  AssistantMessageEventStream,
  type Api,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  buildPrompt,
  buildSystemPrompt,
  buildResumePrompt,
  type PiContext,
} from "./prompt-builder.js";
import {
  spawnClaude,
  writeUserMessage,
  cleanupProcess,
  captureStderr,
  forceKillProcess,
  registerProcess,
  cleanupSystemPromptFile,
  buildClaudeSpawnArgs,
} from "./process-manager.js";
import { parseLine } from "./stream-parser.js";
import { createEventBridge } from "./event-bridge.js";
import { mapThinkingEffort } from "./thinking-config.js";
import { isPiKnownClaudeTool } from "./tool-mapping.js";
/**
 * Inactivity safety net for the Claude CLI subprocess.
 *
 * Set very high (30 minutes) because the caller is the authoritative source of
 * truth for "this session is stuck": Fusion's engine runs a `StuckTaskDetector`
 * with a configurable heartbeat (default 1 hour) and aborts the session via
 * `AbortSignal` when it decides the agent has gone quiet. pi-claude-cli already
 * forwards that signal to the subprocess (`forceKillProcess` on `signal.abort`).
 *
 * A short timeout here was racing the engine: Sonnet 4.6 with extended thinking
 * on the triage prompt (~40k chars) routinely goes >3 minutes between thinking
 * deltas, and we were killing those subprocesses before they could write
 * PROMPT.md and call `fn_review_spec`. The half-hour ceiling is just a
 * last-resort guard for catastrophically hung processes when no abort signal
 * arrives (e.g. someone embeds pi-claude-cli without a stuck detector).
 */
const INACTIVITY_TIMEOUT_MS = 30 * 60_000;
function isDebugStreamEnabled(): boolean {
  return process.env.PI_CLAUDE_CLI_DEBUG === "1";
}

function debugLog(message: string): void {
  if (!isDebugStreamEnabled()) return;
  console.error(`[pi-claude-cli] ${message}`);
}

/** Extended stream options: pi's SimpleStreamOptions plus optional cwd and mcpConfigPath */
type StreamViaCLiOptions = SimpleStreamOptions & {
  cwd?: string;
  mcpConfigPath?: string;
};

/**
 * Stream a response from Claude CLI as an AssistantMessageEventStream.
 *
 * Orchestrates the full subprocess lifecycle: spawn, write prompt, parse NDJSON,
 * bridge events, handle result, and clean up. Implements break-early pattern:
 * at message_stop, if any built-in or custom-tools MCP tool was seen, kills
 * the subprocess before Claude CLI can auto-execute the tools.
 *
 * Hardened with: inactivity timeout, subprocess exit handler with stderr
 * surfacing, streamEnded guard against double errors, abort via SIGKILL, and
 * process registry integration for teardown cleanup.
 *
 * @param model - The model to use (from pi's model catalog)
 * @param context - The conversation context with messages and system prompt
 * @param options - Optional cwd, abort signal, reasoning level, thinking budgets, and mcpConfigPath
 * @returns An AssistantMessageEventStream that receives bridged events
 */
export function streamViaCli(
  model: Model<Api>,
  context: PiContext,
  options?: StreamViaCLiOptions,
): AssistantMessageEventStream {
  // @ts-expect-error — tsc can't verify AssistantMessageEventStream is a value
  // through pi-ai's `export *` re-export chain. The class constructor exists at runtime.
  const stream = new AssistantMessageEventStream();

  (async () => {
    let proc: ReturnType<typeof spawnClaude> | undefined;
    let abortHandler: (() => void) | undefined;
    let rl: ReturnType<typeof createInterface> | undefined;
    const bridge = createEventBridge(stream, model);
    let streamEnded = false;
    let broken = false;
    let inactivityTimer: ReturnType<typeof setTimeout> | undefined;
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });

    // FNXC:ClaudeProviderErrors 2026-09-09-06:10: pi consumes an AssistantMessage
    // on BOTH terminal event variants; text on a normal done event hides failure.
    function endStreamWithError(errMsg: string, reason: "error" | "aborted" = "error") {
      if (streamEnded || broken) return;
      streamEnded = true;
      clearTimeout(inactivityTimer);
      stream.push({
        type: "error",
        reason,
        error: { ...bridge.getOutput(), stopReason: reason, errorMessage: errMsg },
      });
      stream.end();
      finish();
    }

    try {
      if (options?.signal?.aborted) {
        endStreamWithError("Claude CLI request aborted", "aborted");
        return;
      }
      const cwd = options?.cwd ?? process.cwd();

      // Resume if pi provides a session ID AND this isn't the first turn.
      // Pi passes sessionId on every call (including first), but we can only
      // --resume a CLI session that already exists on disk from a prior turn.
      const resumeSessionId =
        options?.sessionId && context.messages.length > 1
          ? options.sessionId
          : undefined;

      // Build prompt: if resuming, only send the latest user turn;
      // otherwise build the full flattened conversation history
      const prompt = resumeSessionId
        ? buildResumePrompt(context)
        : buildPrompt(context);
      const systemPrompt = resumeSessionId
        ? undefined
        : buildSystemPrompt(context, cwd);

      // Compute effort level from reasoning options
      const effort = mapThinkingEffort(
        options?.reasoning,
        model.id,
        options?.thinkingBudgets,
      );

      const spawnOptions = {
        cwd,
        signal: options?.signal,
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      };

      // Spawn subprocess
      proc = spawnClaude(model.id, systemPrompt || undefined, spawnOptions);
      const getStderr = captureStderr(proc);

      // Register in global process registry for teardown cleanup
      registerProcess(proc);
      const spawnArgs = buildClaudeSpawnArgs(model.id, undefined, {
        effort,
        mcpConfigPath: options?.mcpConfigPath,
        resumeSessionId,
        newSessionId: !resumeSessionId ? options?.sessionId : undefined,
      });
      debugLog(
        `spawned claude subprocess pid=${proc.pid ?? "unknown"} args=${JSON.stringify(spawnArgs)}`,
      );

      // Write user message to subprocess stdin
      writeUserMessage(proc, prompt);
      debugLog("user message written to stdin, stdin.end() called");

      function resetInactivityTimer() {
        if (inactivityTimer !== undefined) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          endStreamWithError(
            `Claude CLI subprocess timed out: no output for ${INACTIVITY_TIMEOUT_MS / 1000} seconds`,
          );
          forceKillProcess(proc!);
        }, INACTIVITY_TIMEOUT_MS);
      }

      // Set up abort signal handler -- uses SIGKILL for immediate force-kill
      if (options?.signal) {
        abortHandler = () => {
          endStreamWithError("Claude CLI request aborted", "aborted");
          if (proc) {
            forceKillProcess(proc);
          }
        };

        if (options.signal.aborted) {
          abortHandler();
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      // Track tool_use blocks for break-early decision at message_stop
      let sawBuiltInOrCustomTool = false;
      let firstLineReceived = false;
      let successfulResult = false;
      let sawResult = false;

      // Set up readline for line-by-line NDJSON parsing
      rl = createInterface({
        input: proc.stdout!,
        crlfDelay: Infinity,
        terminal: false,
      });

      // Handle process error -- use endStreamWithError for guard
      proc.on("error", (err: Error) => {
        if (broken) return; // Break-early killed the process intentionally
        const stderr = getStderr();
        endStreamWithError(stderr || err.message);
      });

      // Handle subprocess close -- surface crashes with stderr and exit code
      proc.on("close", (code: number | null, _signal: string | null) => {
        clearTimeout(inactivityTimer);
        debugLog(`subprocess closed: code=${code} signal=${_signal}`);
        if (broken) return; // Break-early kill, expected
        const stderr = getStderr().trim();
        if (stderr) {
          if (code === 0 || code === null) {
            // FN-3815: Claude CLI writes benign MCP bring-up diagnostics to stderr
            // on clean/abort shutdown; keep these debug-only to avoid false TUI warnings.
            debugLog(`Claude CLI stderr on close (clean exit): ${stderr}`);
          } else {
            console.warn(`[pi-claude-cli] Claude CLI stderr on close: ${stderr}`);
          }
        }
        if (code !== 0 && code !== null) {
          const message = stderr
            ? `Claude CLI exited with code ${code}: ${stderr}`
            : `Claude CLI exited unexpectedly with code ${code}`;
          endStreamWithError(message);
        } else if (code === null && !(successfulResult && proc!.killed)) {
          endStreamWithError(`Claude CLI exited without an exit code${_signal ? ` (signal ${_signal})` : ""}`);
        }
        // stdout EOF can precede a failing process close. Wait for this event,
        // not readline.close, before publishing success. A known successful
        // result may need the existing cleanupProcess grace-period kill.
        finish();
      });

      // Start inactivity timer after writing user message
      resetInactivityTimer();

      // Process NDJSON lines from stdout using event-based callback
      // NOTE: Using 'line' event instead of `for await` because the async
      // iterator batches lines, breaking real-time streaming to pi.
      rl.on("line", (line: string) => {
        if (!firstLineReceived) {
          firstLineReceived = true;
          debugLog("first stdout line received from Claude CLI");
        }
        if (broken || streamEnded || sawResult) return;

        // Reset inactivity timer on each line of output
        resetInactivityTimer();

        const msg = parseLine(line);
        if (!msg) return;

        if (msg.type === "stream_event") {
          // Only forward top-level events to pi's event bridge.
          // Sub-agent events (parent_tool_use_id !== null) are internal to the CLI.
          const isTopLevel = !msg.parent_tool_use_id;
          if (isTopLevel) {
            bridge.handleEvent(msg.event);
          }

          // Track tool_use blocks for break-early decision (top-level only)
          if (
            isTopLevel &&
            msg.event.type === "content_block_start" &&
            msg.event.content_block?.type === "tool_use"
          ) {
            const toolName = msg.event.content_block.name;
            if (toolName) {
              const piKnownTool = isPiKnownClaudeTool(toolName);
              debugLog(
                `top-level tool_use seen: ${toolName} (piKnown=${piKnownTool ? "yes" : "no"})`,
              );
              if (piKnownTool) {
                // Built-in tool (Read/Write/etc.) OR custom MCP tool (mcp__custom-tools__*)
                // Internal Claude Code tools (ToolSearch, Task, etc.) are excluded
                sawBuiltInOrCustomTool = true;
              }
            }
          }

          // Break-early at message_stop: kill subprocess before CLI auto-executes tools
          // Only on top-level message_stop — sub-agent message_stop is internal
          if (
            isTopLevel &&
            msg.event.type === "message_stop" &&
            sawBuiltInOrCustomTool
          ) {
            debugLog("break-early triggered at message_stop after pi-known tool_use");
            broken = true; // Set guard BEFORE rl.close() to prevent buffered lines
            clearTimeout(inactivityTimer);
            // Pi will execute these tools. Kill subprocess to prevent CLI from executing them.
            forceKillProcess(proc!);
            rl!.close();
            finish();
            return;
          }
        } else if (msg.type === "control_request") {
          debugLog(
            `unexpected control_request received (stdin already closed): ${msg.request_id}`,
          );
        } else if (msg.type === "result") {
          sawResult = true;
          if (msg.is_error === true || msg.subtype !== "success") {
            const details = [msg.error, ...(Array.isArray(msg.errors) ? msg.errors : []), msg.result]
              .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
            endStreamWithError(details.join("\n") || `Claude CLI failed (${msg.subtype ?? "unknown result"})`);
          } else {
            successfulResult = true;
            const output = bridge.getOutput();
            if (typeof msg.result === "string" && msg.result.trim() &&
                !output.content.some((content) => content.type === "text" && content.text.length > 0)) {
              // Some native CLI responses have only result text. Replay it
              // through the bridge so delta-only callers see the same content.
              const index = output.content.length;
              bridge.handleEvent({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
              bridge.handleEvent({ type: "content_block_delta", index, delta: { type: "text_delta", text: msg.result } });
              bridge.handleEvent({ type: "content_block_stop", index });
            }
          }
          // Keep the inactivity safety net until process close: a child whose
          // inherited stdout never closes must not leave completion unbounded.
          cleanupProcess(proc!);
        }
      });

      await finished;

      // Push done after process close or intentional tool handoff (async). Pushing synchronously
      // inside handleMessageStop prevents pi from executing tools.
      // Guard with streamEnded to avoid pushing done after an error was already pushed.
      if (!streamEnded) {
        const output = bridge.getOutput();
        const contentEvents = output.content || [];

        if (!contentEvents.some((content) => content.type === "toolCall" ||
            (content.type === "text" ? content.text.trim() : content.thinking.trim()))) {
          console.warn(
            `[pi-claude-cli] Claude CLI closed without content events (model=${model.id}, sessionId=${options?.sessionId ?? "none"})`,
          );
          endStreamWithError("Claude CLI closed without content events or result text");
          return;
        }

        // If stopReason is toolUse but there are no pi-known tool calls in content,
        // it means only user MCP tools were called (filtered by event bridge).
        // Override to "stop" so pi doesn't try to execute non-existent tools.
        const piToolCalls = (output.content || []).filter(
          (c: TextContent | ThinkingContent | ToolCall) => c.type === "toolCall",
        );
        const effectiveReason =
          output.stopReason === "toolUse" && piToolCalls.length === 0
            ? "stop"
            : output.stopReason;

        streamEnded = true;
        stream.push({
          type: "done",
          reason:
            effectiveReason === "toolUse"
              ? "toolUse"
              : effectiveReason === "length"
                ? "length"
                : "stop",
          message: { ...output, stopReason: effectiveReason },
        });
        stream.end();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      endStreamWithError(errMsg, options?.signal?.aborted ? "aborted" : "error");
      if (proc) cleanupProcess(proc);
    } finally {
      clearTimeout(inactivityTimer);
      rl?.close();
      // Clean up abort listener
      if (options?.signal && abortHandler) {
        options.signal.removeEventListener("abort", abortHandler);
      }
      if (proc) cleanupSystemPromptFile(proc);
    }
  })();

  return stream;
}
