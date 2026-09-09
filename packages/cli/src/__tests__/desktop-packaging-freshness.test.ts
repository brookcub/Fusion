import { describe, expect, it, vi } from "vitest";

import { refreshDesktopRuntimeAssets, wantsFullCliPackage } from "../../tsup.config";

describe("full CLI desktop packaging freshness", () => {
  it("rebuilds even when desktop dist already exists, so the staged engine closure is current", async () => {
    let current = "old-engine";
    const build = vi.fn(async () => { current = "new-engine"; });

    await refreshDesktopRuntimeAssets({
      desktopRuntimeDir: "desktop/dist",
      // The stale output exists before the call; only the injected desktop
      // builder changes the simulated embedded engine revision.
      exists: (path) => path === "desktop/dist",
      run: build,
    });

    expect(build).toHaveBeenCalledWith("pnpm", ["--filter", "@fusion/desktop", "build"], expect.any(String), 1_800_000);
    expect(current).toBe("new-engine");
  });

  it("refuses a successful builder that did not produce desktop dist", async () => {
    await expect(refreshDesktopRuntimeAssets({
      desktopRuntimeDir: "desktop/dist", exists: () => false, run: async () => {},
    })).rejects.toThrow("did not create expected assets");
  });

  it("propagates desktop build failure instead of staging stale output", async () => {
    await expect(refreshDesktopRuntimeAssets({
      run: async () => { throw new Error("desktop build failed"); },
    })).rejects.toThrow("desktop build failed");
  });

  it("keeps fast local package mode outside the desktop refresh path", () => {
    expect(wantsFullCliPackage({ FUSION_CLI_FULL_PACKAGE: "0" })).toBe(false);
    expect(wantsFullCliPackage({})).toBe(false);
    expect(wantsFullCliPackage({ FUSION_CLI_FULL_PACKAGE: "1" })).toBe(true);
  });
});
