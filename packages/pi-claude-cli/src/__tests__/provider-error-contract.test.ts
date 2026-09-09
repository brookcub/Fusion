import { EventEmitter } from "node:events";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import type { Api, AssistantMessageEvent, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { streamViaCli } from "../provider.js";
import { spawnClaude } from "../process-manager.js";

// Only the subprocess boundary is fake. pi's event stream, bridge and Agent
// consumer below are the installed implementations used by Fusion.
vi.mock("../process-manager.js", () => ({
  spawnClaude: vi.fn(),
  writeUserMessage: vi.fn(),
  cleanupProcess: vi.fn(),
  captureStderr: vi.fn(() => () => ""),
  forceKillProcess: vi.fn(),
  registerProcess: vi.fn(),
  cleanupSystemPromptFile: vi.fn(),
  buildClaudeSpawnArgs: vi.fn(() => []),
}));

// Resolve the declared peer's own Agent dependency (no extra package/version).
const agentRequire = createRequire(realpathSync(new URL("../../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url)));
const agentPackage = pathToFileURL(agentRequire.resolve("@earendil-works/pi-agent-core/package.json"));
const { Agent } = await import(new URL("dist/index.js", agentPackage).href);
const model: Model<Api> = {
  id: "claude-opus-4-8", name: "Claude", api: "pi-claude-cli",
  provider: "pi-claude-cli", baseUrl: "", reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000, maxTokens: 8192,
};
const context = { messages: [{ role: "user", content: "test" }] };

function fakeProcess() {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    stdin: new PassThrough(), pid: 12345, killed: false, exitCode: null,
  });
}

describe("native Claude provider terminal contract", () => {
  let proc: ReturnType<typeof fakeProcess>;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    proc = fakeProcess();
    vi.mocked(spawnClaude).mockReturnValue(proc as unknown as ReturnType<typeof spawnClaude>);
  });
  afterEach(() => {
    proc.stdout.destroy();
    vi.restoreAllMocks();
  });

  function writeResult(result: Record<string, unknown>) {
    proc.stdout.write(`${JSON.stringify({ type: "result", ...result })}\n`);
  }
  async function close(code: number | null = 0, signal: string | null = null) {
    const closingProc = proc;
    closingProc.stdout.end();
    // Real ChildProcess close follows stdout EOF, rather than preceding it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    closingProc.emit("close", code, signal);
  }
  function text(value: string) {
    for (const event of [
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: value } },
      { type: "content_block_stop", index: 0 },
    ]) proc.stdout.write(`${JSON.stringify({ type: "stream_event", event })}\n`);
  }
  async function eventsOf(stream: ReturnType<typeof streamViaCli>) {
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it.each([
    { subtype: "success", is_error: true, result: "Credit balance is too low" },
    { subtype: "error", error: "Credit balance is too low" },
    { subtype: "error_during_execution", errors: ["Credit balance is too low"] },
    { subtype: "error_max_turns", errors: ["Credit balance is too low"] },
  ])("surfaces $subtype / is_error=$is_error as an AssistantMessage error", async (result) => {
    const stream = streamViaCli(model, context);
    writeResult(result);
    await close(1);
    expect(await stream.result()).toMatchObject({
      role: "assistant", stopReason: "error", errorMessage: "Credit balance is too low",
    });
    const terminal = (await eventsOf(stream)).filter((event) => event.type === "done" || event.type === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: "error", reason: "error", error: { stopReason: "error" } });
  });

  it("propagates the credit error into the real Agent state used by the session error check", async () => {
    const agent = new Agent({ initialState: { model }, streamFn: () => {
      const stream = streamViaCli(model, context);
      queueMicrotask(() => {
        writeResult({ subtype: "success", is_error: true, result: "Credit balance is too low" });
        void close(1);
      });
      return stream;
    } });
    await agent.prompt("test");
    expect(agent.state.errorMessage).toBe("Credit balance is too low");
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
    expect(agent.state.isStreaming).toBe(false);
  });

  it.each([false, true])("does not let stdout EOF mask a later failing exit (success result=$hasResult)", async (hasResult) => {
    const stream = streamViaCli(model, context);
    text("partial response");
    if (hasResult) writeResult({ subtype: "success", result: "partial response" });
    await close(17);
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("17") });
  });

  it("fails a clean but empty close instead of returning an empty success", async () => {
    const stream = streamViaCli(model, context);
    await close();
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("without content") });
  });

  it("does not count an empty streamed text block as a response", async () => {
    const stream = streamViaCli(model, context);
    text("");
    writeResult({ subtype: "success", result: "" });
    await close();
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("without content") });
  });

  it("retains a genuine success when the known post-result hang requires cleanup kill", async () => {
    const stream = streamViaCli(model, context);
    writeResult({ subtype: "success", result: "plain response" });
    proc.killed = true;
    await close(null, "SIGKILL");
    expect(await stream.result()).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "plain response" }] });
  });

  it("does not treat an unrelated signal termination as successful cleanup", async () => {
    const stream = streamViaCli(model, context);
    writeResult({ subtype: "success", result: "plain response" });
    await close(null, "SIGTERM");
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: expect.stringContaining("SIGTERM") });
  });

  it("preserves partial content and usage without converting provider failure to success", async () => {
    const stream = streamViaCli(model, context);
    proc.stdout.write(`${JSON.stringify({ type: "stream_event", event: { type: "message_start", message: { usage: { input_tokens: 10 } } } })}\n`);
    text("partial response");
    writeResult({ subtype: "error_during_execution", errors: ["provider failed"] });
    await close(1);
    expect(await stream.result()).toMatchObject({
      stopReason: "error", errorMessage: "provider failed", usage: { input: 10 },
      content: [{ type: "text", text: "partial response" }],
    });
  });

  it("replays genuine result-only success as text deltas for delta-only consumers", async () => {
    const stream = streamViaCli(model, context);
    writeResult({ subtype: "success", is_error: false, result: "plain response" });
    await close();
    expect(await stream.result()).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "plain response" }] });
    expect((await eventsOf(stream)).filter((event) => event.type === "text_delta")).toMatchObject([{ delta: "plain response" }]);
  });

  it("does not duplicate text already streamed when the result repeats it", async () => {
    const stream = streamViaCli(model, context);
    text("streamed response");
    writeResult({ subtype: "success", result: "streamed response" });
    await close();
    expect((await stream.result()).content).toEqual([{ type: "text", text: "streamed response" }]);
    expect((await eventsOf(stream)).filter((event) => event.type === "text_delta")).toHaveLength(1);
  });

  it("publishes only one terminal error across result, process error, EOF and exit", async () => {
    const stream = streamViaCli(model, context);
    writeResult({ subtype: "success", is_error: true, result: "Credit balance is too low" });
    proc.emit("error", new Error("late process error"));
    await close(1);
    expect((await eventsOf(stream)).filter((event) => event.type === "done" || event.type === "error")).toHaveLength(1);
    expect(await stream.result()).toMatchObject({ stopReason: "error", errorMessage: "Credit balance is too low" });
  });

  it("reports synchronous spawn failures through the same error contract", async () => {
    vi.mocked(spawnClaude).mockImplementation(() => { throw new Error("spawn failed"); });
    expect(await streamViaCli(model, context).result()).toMatchObject({ stopReason: "error", errorMessage: "spawn failed" });
  });

  it.each([false, true])("settles cancellation as aborted (already aborted=$alreadyAborted)", async (alreadyAborted) => {
    const controller = new AbortController();
    if (alreadyAborted) controller.abort();
    const stream = streamViaCli(model, context, { signal: controller.signal });
    if (!alreadyAborted) controller.abort();
    await close(null, "SIGKILL");
    expect(await stream.result()).toMatchObject({ stopReason: "aborted", errorMessage: expect.any(String) });
  });
});
