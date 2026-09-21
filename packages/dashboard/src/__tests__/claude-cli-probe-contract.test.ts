import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
import { probeClaudeCli } from "../claude-cli-probe.js";
function child() { return Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() }); }
let lookup: ReturnType<typeof child>, version: ReturnType<typeof child>;
beforeEach(() => { vi.useFakeTimers(); lookup = child(); version = child(); mocks.spawn.mockReset().mockReturnValueOnce(lookup).mockReturnValueOnce(version); });
afterEach(() => { lookup.stdout.destroy(); lookup.stderr.destroy(); version.stdout.destroy(); version.stderr.destroy(); vi.useRealTimers(); });
async function resolveLookup() { lookup.emit("close", 1); await Promise.resolve(); await Promise.resolve(); }
it("control: reports an available binary after successful version execution", async () => {
  const pending = probeClaudeCli({ timeoutMs: 100 }); await resolveLookup(); version.stdout.write("Claude fixture 1\n"); version.emit("close", 0);
  const result = await pending; expect(result.available).toBe(true); expect(result.version).toBe("Claude fixture 1");
});
it("control: bounds a hanging version command", async () => {
  const pending = probeClaudeCli({ timeoutMs: 100 }); await resolveLookup(); await vi.advanceTimersByTimeAsync(100);
  const result = await pending; expect(result.available).toBe(false); expect(result.reason).toContain("timed out"); expect(version.kill).toHaveBeenCalledOnce();
});
it("bounds the entire probe even when optional PATH lookup never settles", async () => {
  let observed: any; const pending = probeClaudeCli({ timeoutMs: 100 }).then((result) => { observed = result; return result; });
  await vi.advanceTimersByTimeAsync(100); const atDeadline = observed;
  lookup.emit("close", 1); await Promise.resolve(); await Promise.resolve(); version.emit("close", 1); await pending;
  expect(atDeadline?.available).toBe(false);
});
it.each(["lookup", "version"])("never rejects when the %s spawn throws synchronously", async (stage) => {
  const error = new Error("synthetic spawn rejection"); mocks.spawn.mockReset(); if (stage === "version") mocks.spawn.mockReturnValueOnce(lookup);
  mocks.spawn.mockImplementationOnce(() => { throw error; });
  const pending = probeClaudeCli({ timeoutMs: 100 }).then((value) => ({ value, error: null }), (rejected) => ({ value: null, error: rejected }));
  if (stage === "version") await resolveLookup(); const result = await pending;
  expect(result.error === null).toBe(true); expect(result.value?.available).toBe(false);
});
