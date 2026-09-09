import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ClaudeCliExtensionResolution =
  | { status: "ok"; path: string; packageVersion: string }
  | { status: "not-installed" }
  | { status: "missing-entry"; reason: string }
  | { status: "error"; reason: string };

/** One resolver for CLI readiness and engine execution, including the shipped raw-TS bundle. */
export function resolveClaudeCliExtensionFromModuleUrl(moduleUrl: string): ClaudeCliExtensionResolution {
  try {
    const here = dirname(fileURLToPath(moduleUrl));
    let packagePath: string | undefined;
    for (const relative of ["pi-claude-cli", "../pi-claude-cli", "../../pi-claude-cli"]) {
      const candidate = resolve(here, relative, "package.json");
      if (existsSync(candidate)) {
        packagePath = candidate;
        break;
      }
    }
    if (!packagePath) {
      try {
        packagePath = createRequire(moduleUrl).resolve("@fusion/pi-claude-cli/package.json");
      } catch {
        return { status: "not-installed" };
      }
    }
    const pkg = JSON.parse(readFileSync(packagePath, "utf-8")) as {
      pi?: { extensions?: unknown }; version?: string;
    };
    const entry = Array.isArray(pkg.pi?.extensions) ? pkg.pi.extensions[0] : undefined;
    if (typeof entry !== "string" || !entry) {
      return { status: "missing-entry", reason: "@fusion/pi-claude-cli package.json has no valid pi.extensions entry" };
    }
    const path = resolve(dirname(packagePath), entry);
    if (!existsSync(path)) {
      return { status: "missing-entry", reason: `@fusion/pi-claude-cli extension file not found at ${path}` };
    }
    return { status: "ok", path, packageVersion: pkg.version ?? "unknown" };
  } catch (error) {
    return { status: "error", reason: `Failed to resolve @fusion/pi-claude-cli: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Only the selected bundle may own this provider ID; unrelated registrations stay intact. */
export function selectClaudeCliProviderRegistrations<T extends { name: string; extensionPath: string }>(
  registrations: readonly T[], vendoredPath: string | null,
): T[] {
  return registrations.filter((registration) => registration.name !== "pi-claude-cli"
    || (vendoredPath !== null && resolve(registration.extensionPath) === resolve(vendoredPath)));
}
