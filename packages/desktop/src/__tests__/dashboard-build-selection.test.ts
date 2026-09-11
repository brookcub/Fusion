import { EventEmitter } from "node:events";
import { basename } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), cp: vi.fn(), rm: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(), cp: mocks.cp, rm: mocks.rm,
}));
import { buildDashboard, buildDashboardClient, DASHBOARD_RUNTIME_PLUGIN_PACKAGES } from "../../scripts/workspace-tools";

const toolName = (value: string) => basename(value).replace(/\.(cmd|js)$/, "");
const callsFor = (tool: string) => mocks.spawn.mock.calls
  .map(([command, args]) => [command, command === process.execPath ? args : [command, ...args]])
  .filter(([, args]) => toolName(args[0]) === toolName(tool));

describe("desktop dashboard build selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cp.mockResolvedValue(undefined);
    mocks.rm.mockResolvedValue(undefined);
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
  });

  it("retains the ordinary client for standalone dashboard/test callers", async () => {
    await buildDashboard();
    expect(callsFor("vite.js").map(([, args]) => args.slice(1))).toEqual([["build"]]);
    expect(callsFor("tsc")).toHaveLength(DASHBOARD_RUNTIME_PLUGIN_PACKAGES.length + 2);
    expect(mocks.cp).toHaveBeenCalledWith(expect.stringMatching(/src[\\/]registry-manifest\.json$/), expect.stringMatching(/dist[\\/]registry-manifest\.json$/));
  });

  it("builds server/plugins/registry without an ordinary client when desktop supplies its own", async () => {
    await buildDashboard({ includeClient: false });
    expect(callsFor("vite.js")).toHaveLength(0);
    expect(callsFor("tsc")).toHaveLength(DASHBOARD_RUNTIME_PLUGIN_PACKAGES.length + 2);
    expect(mocks.cp).toHaveBeenCalledTimes(1);
  });

  it("performs exactly one clean relative-base client build for the desktop sequence", async () => {
    await buildDashboard({ includeClient: false });
    await buildDashboardClient();
    expect(callsFor("vite.js").map(([, args]) => args.slice(1))).toEqual([["build", "--base", "./"]]);
    expect(mocks.rm).toHaveBeenCalledTimes(1);
    expect(mocks.rm).toHaveBeenCalledWith(expect.stringMatching(/dashboard[\\/]dist[\\/]client$/), { recursive: true, force: true });
  });

  it("still refuses packaging when the plugin build fails", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 2));
      return child;
    });
    await expect(buildDashboard({ includeClient: false })).rejects.toThrow("exited with code 2");
    expect(mocks.cp).not.toHaveBeenCalled();
    expect(callsFor("vite.js")).toHaveLength(0);
  });

  it("propagates a failure of the final relative-base client build", async () => {
    mocks.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 3));
      return child;
    });
    await expect(buildDashboardClient()).rejects.toThrow("exited with code 3");
    expect(callsFor("vite.js").map(([, args]) => args.slice(1))).toEqual([["build", "--base", "./"]]);
  });
});
