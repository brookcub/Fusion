from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one anchor, found {count}\nANCHOR:\n{old}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")


helper = '''import { reconcileClaudeCliPaths } from "@fusion/core";

export interface CliExtensionPathCandidates {
  selfExtensionPaths: readonly string[];
  discoveredExtensionPaths: readonly string[];
  packageExtensionPaths: readonly string[];
  claudeCliPaths: readonly string[];
  droidCliPaths: readonly string[];
  llamaCppPaths: readonly string[];
}

/**
 * Single CLI policy boundary for the extension list handed to pi.
 *
 * Command roots may discover candidates differently, but provider precedence
 * belongs here so dashboard, serve, and daemon cannot drift independently.
 */
export function finalizeCliExtensionPaths({
  selfExtensionPaths,
  discoveredExtensionPaths,
  packageExtensionPaths,
  claudeCliPaths,
  droidCliPaths,
  llamaCppPaths,
}: CliExtensionPathCandidates): string[] {
  return reconcileClaudeCliPaths(
    [
      ...selfExtensionPaths,
      ...discoveredExtensionPaths,
      ...packageExtensionPaths,
      ...claudeCliPaths,
      ...droidCliPaths,
      ...llamaCppPaths,
    ],
    claudeCliPaths[0] ?? null,
  );
}
'''

test = '''import { describe, expect, it } from "vitest";
import { finalizeCliExtensionPaths } from "../extension-paths.js";

const SELF = "/fusion/self-extension.ts";
const DISCOVERED = "/project/.fusion/extensions/local.ts";
const PACKAGE = "/packages/unrelated-extension/index.ts";
const VENDORED = "/fusion/node_modules/@fusion/pi-claude-cli/index.ts";
const EXTERNAL = "/usr/local/lib/node_modules/pi-claude-cli/index.ts";
const DROID = "/fusion/node_modules/@fusion/droid-cli/index.ts";
const LLAMA = "/fusion/node_modules/@fusion/llama-cpp/index.ts";

describe("finalizeCliExtensionPaths", () => {
  it("applies one Claude precedence policy across the assembled CLI candidates", () => {
    const result = finalizeCliExtensionPaths({
      selfExtensionPaths: [SELF],
      discoveredExtensionPaths: [DISCOVERED],
      packageExtensionPaths: [PACKAGE, VENDORED, EXTERNAL],
      claudeCliPaths: [VENDORED],
      droidCliPaths: [DROID],
      llamaCppPaths: [LLAMA],
    });

    expect(result).toEqual([
      VENDORED,
      SELF,
      DISCOVERED,
      PACKAGE,
      DROID,
      LLAMA,
    ]);
  });

  it("preserves candidate order when no vendored Claude adapter is enabled", () => {
    const result = finalizeCliExtensionPaths({
      selfExtensionPaths: [SELF],
      discoveredExtensionPaths: [DISCOVERED],
      packageExtensionPaths: [PACKAGE],
      claudeCliPaths: [],
      droidCliPaths: [DROID],
      llamaCppPaths: [LLAMA],
    });

    expect(result).toEqual([SELF, DISCOVERED, PACKAGE, DROID, LLAMA]);
  });
});
'''

helper_path = Path("packages/cli/src/commands/extension-paths.ts")
test_path = Path("packages/cli/src/commands/__tests__/extension-paths.test.ts")
if helper_path.exists() or test_path.exists():
    raise SystemExit("shared finalizer files unexpectedly already exist")
helper_path.write_text(helper, encoding="utf-8")
test_path.write_text(test, encoding="utf-8")

import_anchor = 'import { resolveSelfExtension } from "./self-extension.js";\n'
import_replacement = import_anchor + 'import { finalizeCliExtensionPaths } from "./extension-paths.js";\n'
for path in [
    "packages/cli/src/commands/serve.ts",
    "packages/cli/src/commands/daemon.ts",
    "packages/cli/src/commands/dashboard.ts",
]:
    replace_once(path, import_anchor, import_replacement)

replace_once(
    "packages/cli/src/commands/daemon.ts",
    "  reconcileClaudeCliPaths,\n",
    "",
)

daemon_old = '''    const reconciledExtensionPaths = reconcileClaudeCliPaths(
      [...selfExtensionPaths, ...getEnabledPiExtensionPaths(primaryCwd), ...packageExtensionPaths, ...claudeCliPaths],
      claudeCliPaths[0] ?? null,
    );

    const extensionsResult = await discoverAndLoadExtensions(
      [...reconciledExtensionPaths, ...droidCliPaths, ...llamaCppPaths],
      primaryCwd,
'''
daemon_new = '''    const extensionPaths = finalizeCliExtensionPaths({
      selfExtensionPaths,
      discoveredExtensionPaths: getEnabledPiExtensionPaths(primaryCwd),
      packageExtensionPaths,
      claudeCliPaths,
      droidCliPaths,
      llamaCppPaths,
    });

    const extensionsResult = await discoverAndLoadExtensions(
      extensionPaths,
      primaryCwd,
'''
replace_once("packages/cli/src/commands/daemon.ts", daemon_old, daemon_new)

serve_old = '''    const extensionsResult = await discoverAndLoadExtensions(
      [
        ...selfExtensionPaths,
        ...getEnabledPiExtensionPaths(primaryCwd),
        ...packageExtensionPaths,
        ...claudeCliPaths,
        ...droidCliPaths,
        ...llamaCppPaths,
      ],
      primaryCwd,
'''
serve_new = '''    const extensionPaths = finalizeCliExtensionPaths({
      selfExtensionPaths,
      discoveredExtensionPaths: getEnabledPiExtensionPaths(primaryCwd),
      packageExtensionPaths,
      claudeCliPaths,
      droidCliPaths,
      llamaCppPaths,
    });

    const extensionsResult = await discoverAndLoadExtensions(
      extensionPaths,
      primaryCwd,
'''
replace_once("packages/cli/src/commands/serve.ts", serve_old, serve_new)

dashboard_old = '''    const extensionsResult = await boundedPhaseTime("discoverAndLoadExtensions", () => discoverAndLoadExtensions(
      [
        ...selfExtensionPaths,
        ...getEnabledPiExtensionPaths(cwd),
        ...packageExtensionPaths,
        ...claudeCliPaths,
        ...droidCliPaths,
        ...llamaCppPaths,
      ],
      cwd,
'''
dashboard_new = '''    const extensionPaths = finalizeCliExtensionPaths({
      selfExtensionPaths,
      discoveredExtensionPaths: getEnabledPiExtensionPaths(cwd),
      packageExtensionPaths,
      claudeCliPaths,
      droidCliPaths,
      llamaCppPaths,
    });

    const extensionsResult = await boundedPhaseTime("discoverAndLoadExtensions", () => discoverAndLoadExtensions(
      extensionPaths,
      cwd,
'''
replace_once("packages/cli/src/commands/dashboard.ts", dashboard_old, dashboard_new)

replace_once(
    ".changeset/f25-vendored-claude-order.md",
    "summary: Keep Fusion's vendored Claude CLI adapter first when reconciling extension paths.\ncategory: fix\ndev: Remove any existing vendored occurrence before prepending the canonical adapter path while filtering external aliases.",
    "summary: Prevent installed Claude CLI adapters from overriding Fusion's bundled Claude integration.\ncategory: fix\ndev: Centralize CLI extension-path finalization so dashboard, serve, and daemon apply the same vendored Claude precedence.",
)
