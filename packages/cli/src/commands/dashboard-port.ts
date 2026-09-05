import { GlobalSettingsStore, resolveGlobalDir } from "@fusion/core";

export const DEFAULT_DASHBOARD_PORT = 4040;

export type DashboardPortSettingsReader = () => Promise<{ daemonPort?: unknown }> | { daemonPort?: unknown };

export interface ResolveDashboardPortOptions {
  explicitPort?: number;
  readSettings?: DashboardPortSettingsReader;
}

function isUsableDashboardPort(port: unknown): port is number {
  return Number.isInteger(port) && port > 0;
}

async function readGlobalDashboardPortSettings(): Promise<{ daemonPort?: unknown }> {
  return new GlobalSettingsStore(resolveGlobalDir()).getSettings();
}

/**
 * Resolve dashboard listen-port precedence for CLI startup.
 *
 * FNXC:DashboardPortSettings 2026-09-05-05:37:
 * `daemonPort` remains the backward-compatible dashboard listen-port setting because existing operators already store their local server port there. `--port`/`-p` stays the run-local override so a one-off dashboard launch never mutates or loses the global fallback.
 */
export async function resolveDashboardPort({
  explicitPort,
  readSettings = readGlobalDashboardPortSettings,
}: ResolveDashboardPortOptions = {}): Promise<number> {
  if (isUsableDashboardPort(explicitPort)) {
    return explicitPort;
  }

  const settings = await readSettings();
  if (isUsableDashboardPort(settings.daemonPort)) {
    return settings.daemonPort;
  }

  return DEFAULT_DASHBOARD_PORT;
}
