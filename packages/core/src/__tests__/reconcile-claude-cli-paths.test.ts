import { describe, it, expect } from "vitest";
import { reconcileClaudeCliPaths } from "../plugins/pi-extensions.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempWorkspace } from "../__test-utils__/workspace.js";

const VENDORED = "/repo/packages/pi-claude-cli/index.ts";
const GLOBAL_NPM = "/opt/homebrew/lib/node_modules/pi-claude-cli/index.ts";
const PI_AGENT = "/Users/u/.pi/agent/extensions/pi-claude-cli/index.ts";
const UNRELATED = "/Users/u/.pi/agent/extensions/quota.ts";

describe("reconcileClaudeCliPaths", () => {
  it("excludes a renamed adapter by its package identity before loading it", () => {
    const root = tempWorkspace("claude-alias-");
    const alias = join(root, "claude-cli-lanes");
    mkdirSync(alias);
    writeFileSync(join(alias, "package.json"), JSON.stringify({ name: "@fusion/pi-claude-cli", pi: { extensions: ["index.ts"] } }));
    writeFileSync(join(alias, "index.ts"), "throw new Error('must not execute alias');");
    expect(reconcileClaudeCliPaths([join(alias, "index.ts"), UNRELATED], VENDORED)).toEqual([VENDORED, UNRELATED]);
    expect(reconcileClaudeCliPaths([alias], VENDORED)).toEqual([VENDORED]);
  });

  it("preserves unrelated and malformed package manifests", () => {
    const root = tempWorkspace("claude-unrelated-");
    const other = join(root, "other");
    const malformed = join(root, "malformed");
    mkdirSync(other);
    mkdirSync(malformed);
    writeFileSync(join(other, "package.json"), JSON.stringify({ name: "claude-helper" }));
    writeFileSync(join(malformed, "package.json"), "{");
    expect(reconcileClaudeCliPaths([other, malformed], VENDORED)).toEqual([VENDORED, other, malformed]);
  });
  it("rejects external native adapters without a trusted bundle, preserving unrelated paths", () => {
    const input = [GLOBAL_NPM, UNRELATED];
    expect(reconcileClaudeCliPaths(input, null)).toEqual([UNRELATED]);
  });

  it("drops a globally-installed pi-claude-cli and prepends the vendored path", () => {
    const result = reconcileClaudeCliPaths([GLOBAL_NPM, UNRELATED], VENDORED);
    expect(result).toEqual([VENDORED, UNRELATED]);
  });

  it("drops pi-claude-cli installed under .pi/agent/extensions/", () => {
    const result = reconcileClaudeCliPaths([PI_AGENT, UNRELATED], VENDORED);
    expect(result).toEqual([VENDORED, UNRELATED]);
  });

  it("keeps the vendored path exactly once even if it appears in input", () => {
    const result = reconcileClaudeCliPaths(
      [VENDORED, GLOBAL_NPM, UNRELATED],
      VENDORED,
    );
    expect(result).toEqual([VENDORED, UNRELATED]);
  });

  it("preserves the relative order of unrelated extension paths", () => {
    const a = "/ext/a.ts";
    const b = "/ext/b.ts";
    const c = "/ext/c.ts";
    const result = reconcileClaudeCliPaths([a, GLOBAL_NPM, b, c], VENDORED);
    expect(result).toEqual([VENDORED, a, b, c]);
  });

  it("does not mistake substrings of pi-claude-cli for the package", () => {
    const looksLike = "/ext/some-pi-claude-cli-helper/index.ts";
    const result = reconcileClaudeCliPaths([looksLike], VENDORED);
    expect(result).toEqual([VENDORED, looksLike]);
  });

  it("matches case-insensitively (e.g. on macOS-cased filesystems)", () => {
    const upper = "/opt/homebrew/lib/node_modules/PI-CLAUDE-CLI/index.ts";
    const result = reconcileClaudeCliPaths([upper], VENDORED);
    expect(result).toEqual([VENDORED]);
  });
});
