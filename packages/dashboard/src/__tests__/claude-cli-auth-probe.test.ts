import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeClaudeCli } from "../claude-cli-probe.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
type Step = { stdout?: string; stderr?: string; code?: number; hang?: boolean; throws?: boolean; delay?: number };

describe("bounded native Claude login probe", () => {
  let steps: Step[];
  let children: Array<ReturnType<typeof child>>;
  function child() {
    return Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  }
  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    steps = [{ stdout: "/fixture/claude\n" }, { stdout: "2.1.0 (Claude Code)\n" }, { stdout: '{"loggedIn":true}' }];
    vi.mocked(spawn).mockImplementation(() => {
      const step = steps.shift() ?? {};
      if (step.throws) throw new Error("fixture spawn error");
      const proc = child();
      children.push(proc);
      const finish = () => {
        if (step.stdout) proc.stdout.emit("data", Buffer.from(step.stdout));
        if (step.stderr) proc.stderr.emit("data", Buffer.from(step.stderr));
        if (!step.hang) proc.emit("close", step.code ?? 0);
      };
      if (step.delay) setTimeout(finish, step.delay);
      else queueMicrotask(finish);
      return proc as unknown as ReturnType<typeof spawn>;
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it.each([true, false, "true", null, undefined])("requires literal loggedIn true, not version success (%s)", async (loggedIn) => {
    steps[2] = { stdout: JSON.stringify({ loggedIn }) };
    expect(await probeClaudeCli()).toMatchObject({ available: true, authenticated: loggedIn === true });
    expect(vi.mocked(spawn).mock.calls[2][1]).toEqual(["auth", "status", "--json"]);
  });
  it.each(["not json", "[]", "null", '{"loggedIn":true}trailing'])("fails closed on malformed auth output %s", async (stdout) => {
    steps[2] = { stdout };
    expect(await probeClaudeCli()).toMatchObject({ available: true, authenticated: false, reason: expect.any(String) });
  });
  it("uses the adapter's child-only auth policy without modifying the parent", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "fixture-direct-key");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fixture-direct-token");
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fixture-oauth");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/fixture/config");
    await probeClaudeCli();
    const env = vi.mocked(spawn).mock.calls.at(-1)![2]!.env!;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("fixture-oauth");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/fixture/config");
    expect(process.env.ANTHROPIC_API_KEY).toBe("fixture-direct-key");
  });
  it.each([0, 1, 2])("bounds the whole probe when stage %s hangs", async (stage) => {
    steps[stage] = { hang: true };
    const pending = probeClaudeCli({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.authenticated).toBe(false);
    expect(result.probeDurationMs).toBeLessThanOrEqual(100);
    expect(children[stage].kill).toHaveBeenCalledWith("SIGKILL");
  });
  it("shares the deadline instead of granting each stage a fresh timeout", async () => {
    steps[0].delay = 40;
    steps[1].delay = 40;
    steps[2] = { hang: true };
    const pending = probeClaudeCli({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ available: true, authenticated: false, probeDurationMs: 100 });
  });
  it.each([0, 1, 2])("handles synchronous spawn failure at stage %s without rejecting", async (stage) => {
    steps[stage] = { throws: true };
    if (stage === 0) steps = [steps[0], { throws: true }];
    expect(await probeClaudeCli()).toMatchObject({ authenticated: false });
  });
  it("rejects nonzero auth exit even with loggedIn true", async () => {
    steps[2].code = 1;
    expect(await probeClaudeCli()).toMatchObject({ available: true, authenticated: false });
  });
  it("caps output and does not return auth payload or stderr diagnostics", async () => {
    steps[2] = { stdout: "fixture-private-payload".repeat(2048), stderr: "fixture-private-stderr", hang: true };
    const result = await probeClaudeCli();
    expect(result).toMatchObject({ available: true, authenticated: false });
    expect(children[2].kill).toHaveBeenCalledWith("SIGKILL");
    expect(JSON.stringify(result)).not.toContain("fixture-private");
  });
});
