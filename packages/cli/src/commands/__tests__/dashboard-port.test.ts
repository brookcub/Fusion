import { describe, expect, it, vi } from "vitest";

import { DEFAULT_DASHBOARD_PORT, resolveDashboardPort } from "../dashboard-port.js";

describe("resolveDashboardPort", () => {
  it("uses an explicit CLI port before settings", async () => {
    const readSettings = vi.fn(async () => ({ daemonPort: 5678 }));

    await expect(resolveDashboardPort({ explicitPort: 6789, readSettings })).resolves.toBe(6789);

    expect(readSettings).not.toHaveBeenCalled();
  });

  it("uses daemonPort from settings when no CLI port exists", async () => {
    const readSettings = vi.fn(async () => ({ daemonPort: 5678 }));

    await expect(resolveDashboardPort({ readSettings })).resolves.toBe(5678);

    expect(readSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    undefined,
    { daemonPort: undefined },
    { daemonPort: 0 },
    { daemonPort: -1 },
    { daemonPort: Number.NaN },
    { daemonPort: "5678" },
  ])("falls back to the default port for absent or unusable settings (%s)", async (settings) => {
    const readSettings = vi.fn(async () => settings ?? {});

    await expect(resolveDashboardPort({ readSettings })).resolves.toBe(DEFAULT_DASHBOARD_PORT);

    expect(readSettings).toHaveBeenCalledTimes(1);
  });

  it("does not mutate settings while resolving", async () => {
    const settings = { daemonPort: 5678 };

    await expect(resolveDashboardPort({ readSettings: () => settings })).resolves.toBe(5678);

    expect(settings).toEqual({ daemonPort: 5678 });
  });
});
