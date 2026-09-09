import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { tempWorkspace } from "../__test-utils__/workspace.js";
import { resolveClaudeCliExtensionFromModuleUrl, selectClaudeCliProviderRegistrations } from "../plugins/claude-cli-extension.js";

describe("packaged Claude provider resolution", () => {
  it.each(["cli.js", "chunks/engine.js", "commands/nested/engine.js"])("resolves bundled raw source from %s without a workspace dependency", (module) => {
    const root = tempWorkspace("claude-packaged-");
    const pkg = join(root, "dist", "pi-claude-cli");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@fusion/pi-claude-cli", version: "test", pi: { extensions: ["index.ts"] } }));
    writeFileSync(join(pkg, "index.ts"), "export default () => {};\n");
    expect(resolveClaudeCliExtensionFromModuleUrl(pathToFileURL(join(root, "dist", module)).href)).toEqual({ status: "ok", path: join(pkg, "index.ts"), packageVersion: "test" });
  });

  it("fails closed for absent, malformed, and incomplete bundles", () => {
    const root = tempWorkspace("claude-broken-");
    const module = pathToFileURL(join(root, "dist", "cli.js")).href;
    expect(resolveClaudeCliExtensionFromModuleUrl(module).status).toBe("not-installed");
    const pkg = join(root, "dist", "pi-claude-cli");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), "{");
    expect(resolveClaudeCliExtensionFromModuleUrl(module).status).toBe("error");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ pi: { extensions: ["index.ts"] } }));
    expect(resolveClaudeCliExtensionFromModuleUrl(module).status).toBe("missing-entry");
  });

  it("rejects canonical-ID impostors regardless of load order, retaining other providers", () => {
    const vendored = join(tempWorkspace("claude-registration-"), "index.ts");
    const correct = { name: "pi-claude-cli", extensionPath: vendored, config: { marker: "correct" } };
    const alias = { name: "pi-claude-cli", extensionPath: "alias/index.ts", config: { marker: "old" } };
    const unrelated = { ...alias, name: "other-provider" };
    expect(selectClaudeCliProviderRegistrations([alias, correct, unrelated, alias], vendored)).toEqual([correct, unrelated]);
    expect(selectClaudeCliProviderRegistrations([alias, unrelated], vendored)).toEqual([unrelated]);
    expect(selectClaudeCliProviderRegistrations([alias, unrelated], null)).toEqual([unrelated]);
  });
});
