import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DefaultResourceLoader, discoverAndLoadExtensions, SettingsManager } from "@earendil-works/pi-coding-agent";
import { tempWorkspace } from "@fusion/test-utils";
import { reconcileClaudeCliPaths, resolveClaudeCliExtensionFromModuleUrl, selectClaudeCliProviderRegistrations } from "@fusion/core";

describe("packaged Claude extension loading through the real SDK", () => {
  it.each(["absent", "malformed"])("does not execute a renamed native alias when the bundle is %s", async (condition) => {
    const root = tempWorkspace("claude-unavailable-loader-");
    const alias = join(root, "agent", "extensions", "claude-cli-lanes");
    mkdirSync(alias, { recursive: true });
    writeFileSync(join(alias, "package.json"), JSON.stringify({ name: "@fusion/pi-claude-cli", pi: { extensions: ["index.ts"] } }));
    writeFileSync(join(alias, "index.ts"), "throw new Error('unavailable-bundle alias executed');");
    const other = join(root, "other.ts");
    writeFileSync(other, "export default (pi) => { pi.registerProvider('unrelated-provider', { models: [] }); pi.registerProvider('pi-claude-cli', { models: [] }); };");
    if (condition === "malformed") {
      const bundled = join(root, "dist", "pi-claude-cli");
      mkdirSync(bundled, { recursive: true });
      writeFileSync(join(bundled, "package.json"), "{");
    }
    const resolution = resolveClaudeCliExtensionFromModuleUrl(pathToFileURL(join(root, "dist", "cli.js")).href);
    expect(resolution.status).toBe(condition === "absent" ? "not-installed" : "error");
    const paths = reconcileClaudeCliPaths([join(alias, "index.ts"), other], null);
    expect(paths).toEqual([other]);
    const first = await discoverAndLoadExtensions(paths, root, join(root, "disabled-discovery"));
    expect(first.errors).toEqual([]);
    expect(selectClaudeCliProviderRegistrations(first.runtime.pendingProviderRegistrations, null).map(({ name }) => name)).toEqual(["unrelated-provider"]);
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ extensions: [join(alias, "index.ts")] }),
      noExtensions: true, additionalExtensionPaths: paths,
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    expect(selectClaudeCliProviderRegistrations(loader.getExtensions().runtime.pendingProviderRegistrations, null).map(({ name }) => name)).toEqual(["unrelated-provider"]);
  });
  it("loads the bundled provider and unrelated extension on both passes without executing the renamed alias", async () => {
    const root = tempWorkspace("claude-packaged-loader-");
    const bundled = join(root, "dist", "pi-claude-cli");
    const alias = join(root, "agent", "extensions", "claude-cli-lanes");
    const other = join(root, "other");
    for (const directory of [bundled, alias, other]) mkdirSync(directory, { recursive: true });
    const entry = (directory: string) => join(directory, "index.ts");
    for (const directory of [bundled, alias]) writeFileSync(join(directory, "package.json"), JSON.stringify({ name: "@fusion/pi-claude-cli", pi: { extensions: ["index.ts"] } }));
    writeFileSync(entry(alias), "throw new Error('rejected alias executed');");
    writeFileSync(entry(bundled), "export default (pi) => pi.registerProvider('pi-claude-cli', { models: [] });");
    writeFileSync(entry(other), "export default (pi) => pi.registerProvider('unrelated-provider', { models: [] });");
    const resolution = resolveClaudeCliExtensionFromModuleUrl(pathToFileURL(join(root, "dist", "cli.js")).href);
    expect(resolution.status).toBe("ok");
    if (resolution.status !== "ok") throw new Error("fixture bundle not resolved");
    const paths = reconcileClaudeCliPaths([entry(alias), entry(other)], resolution.path);
    const first = await discoverAndLoadExtensions(paths, root, join(root, "disabled-discovery"));
    expect(first.errors).toEqual([]);
    expect(first.runtime.pendingProviderRegistrations.map(({ name }) => name).sort()).toEqual(["pi-claude-cli", "unrelated-provider"]);

    // Real SDK semantics: noExtensions disables configured/automatic paths,
    // but explicitly supplied reconciled paths still run on the second pass.
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ extensions: [entry(alias)] }),
      noExtensions: true, additionalExtensionPaths: paths,
      extensionsOverride: (base) => ({ ...base, runtime: { ...base.runtime,
        pendingProviderRegistrations: selectClaudeCliProviderRegistrations(base.runtime.pendingProviderRegistrations, resolution.path),
      } }),
    });
    await loader.reload();
    const second = loader.getExtensions();
    expect(second.errors).toEqual([]);
    expect(second.extensions.map(({ path }) => path)).not.toContain(entry(alias));
    expect(second.runtime.pendingProviderRegistrations.map(({ name }) => name).sort()).toEqual(["pi-claude-cli", "unrelated-provider"]);
  });
});
