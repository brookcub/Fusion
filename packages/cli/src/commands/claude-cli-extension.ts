/**
 * Resolver for the vendored `@fusion/pi-claude-cli` pi extension.
 *
 * `@fusion/pi-claude-cli` is a workspace package at `packages/pi-claude-cli/`,
 * a soft fork of rchern/pi-claude-cli (see that package's UPSTREAM.md). It
 * ships its extension entry as raw `.ts` source — pi's loader compiles TS on
 * the fly via jiti, so we just need to point pi at the right file.
 *
 * We deliberately do NOT auto-add "npm:@fusion/pi-claude-cli" to the user's
 * ~/.fusion/agent/settings.json packages array. The package is resolved from
 * this workspace at runtime and loaded explicitly only when
 * GlobalSettings.useClaudeCli is true — this avoids polluting user-owned
 * config files and lets us gate the extension on a UI toggle without
 * settings.json churn.
 */

import { fileURLToPath } from "node:url";
import { resolveClaudeCliExtensionFromModuleUrl } from "@fusion/core";
import type { ClaudeCliExtensionResolution } from "@fusion/core";
export { resolveClaudeCliExtensionFromModuleUrl } from "@fusion/core";
export type { ClaudeCliExtensionResolution } from "@fusion/core";

export function resolveClaudeCliExtension(): ClaudeCliExtensionResolution {
  return resolveClaudeCliExtensionFromModuleUrl(import.meta.url);
}

/**
 * Compute the paths to append to `discoverAndLoadExtensions`' configuredPaths
 * based on the user's `useClaudeCli` setting.
 *
 * When the setting is off we return no paths at all — the bundled
 * `@fusion/pi-claude-cli` sits idle in node_modules and contributes nothing
 * to the running pi session. Flipping the toggle on requires a server
 * restart to pick up the new extension (pi has no stable runtime-reload API
 * for custom provider registrations). The dashboard toggle hook surfaces
 * this in its status response.
 *
 * `warning` is populated when resolution fails (corrupted install, missing
 * entry). Callers should log it but must not fail startup — the feature is
 * optional.
 */
export function resolveClaudeCliExtensionPaths(globalSettings: {
  useClaudeCli?: unknown;
}): { paths: string[]; warning?: string; resolution: ClaudeCliExtensionResolution | null } {
  const enabled = globalSettings?.useClaudeCli === true;
  if (!enabled) {
    return { paths: [], resolution: null };
  }

  const resolution = resolveClaudeCliExtension();
  switch (resolution.status) {
    case "ok":
      return { paths: [resolution.path], resolution };
    case "not-installed":
      return {
        paths: [],
        resolution,
        warning:
          "useClaudeCli is on but @fusion/pi-claude-cli is not installed in node_modules. Run `pnpm install`.",
      };
    case "missing-entry":
    case "error":
      return { paths: [], resolution, warning: resolution.reason };
  }
}

/**
 * Last-observed resolution cached per-process. Populated by the CLI bootstrap
 * (serve/daemon/dashboard) immediately after calling
 * `resolveClaudeCliExtensionPaths`, so HTTP endpoints like
 * GET /api/providers/claude-cli/status can report the same view of the world
 * that the extension loader saw without re-probing node_modules on every
 * request.
 */
let cachedResolution: ClaudeCliExtensionResolution | null = null;

export function setCachedClaudeCliResolution(
  resolution: ClaudeCliExtensionResolution | null,
): void {
  cachedResolution = resolution;
}

export function getCachedClaudeCliResolution(): ClaudeCliExtensionResolution | null {
  return cachedResolution;
}

/**
 * Test helper: allow tests to point the resolver at a fake package.
 * Call with `undefined` to restore the real resolver. Never used in prod.
 */
// Exported for use by tests — see claude-cli-extension.test.ts
export const _testInternals = {
  moduleUrl: (): string => fileURLToPath(import.meta.url),
};
