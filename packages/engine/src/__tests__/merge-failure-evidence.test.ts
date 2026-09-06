import { describe, expect, it, vi } from "vitest";
import { reportMergeFailure } from "../merge/merge-failure-evidence.js";

describe("merge failure evidence", () => {
  it("keeps only fixed categories and bounded source coordinates", () => {
    const error = Object.assign(new TypeError("Unauthorized: private-token task prose"), { code: "ENOENT" });
    error.stack = "TypeError: private-token\n    at call (C:\\private-home\\index.js:123:45)\n    at other (/private-home/private-token.js:20:3)";
    const write = vi.fn();
    reportMergeFailure(error, "merge-review", write);
    const message = write.mock.calls[0][0] as string;
    const data = JSON.parse(message.slice(message.indexOf("{")));
    expect(data).toEqual({ stage: "merge-review", kind: "TypeError", code: "ENOENT", category: "authentication", frames: [{ source: "index.js", line: 123, column: 45 }, { source: "other", line: 20, column: 3 }] });
    expect(message).not.toMatch(/private-token|private-home|task prose|Unauthorized/);
  });

  it("does not serialize unknown names, codes or thrown objects", () => {
    const write = vi.fn();
    const error = Object.assign(new Error("private"), { name: "secret-name", code: "secret-code", stack: "private" });
    reportMergeFailure(error, "landing", write);
    reportMergeFailure({ token: "private" }, "landing", write);
    for (const [message] of write.mock.calls) {
      expect(message).toContain('"kind":"unknown"');
      expect(message).toContain('"code":"unknown"');
      expect(message).not.toMatch(/private|secret/);
    }
  });

  it("cannot throw on hostile getters or logging failures", () => {
    const error = new Error("private");
    Object.defineProperty(error, "stack", { get() { throw new Error("getter failed"); } });
    expect(() => reportMergeFailure(error, "clean-room", vi.fn())).not.toThrow();
    expect(() => reportMergeFailure(new Error("private"), "dependencies", () => { throw new Error("sink failed"); })).not.toThrow();
  });

  it("snapshots changing error names before whitelist validation", () => {
    const error = new Error("private");
    let reads = 0;
    Object.defineProperty(error, "name", { get() { return ++reads === 1 ? "Error" : "private-token"; } });
    error.stack = "fixed";
    const write = vi.fn();
    reportMergeFailure(error, "merge-review", write);
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain('"kind":"Error"');
    expect(write.mock.calls[0][0]).not.toContain("private-token");
    expect(reads).toBe(1);
  });
});
