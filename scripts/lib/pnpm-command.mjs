import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);

/** Resolve pnpm.cmd to its JavaScript entrypoint so Windows receives literal argv. */
export function resolvePnpmCommand(command, args, {
  platform = process.platform,
  node = process.execPath,
  resolve = require.resolve,
  findShim = () => spawnSync("where.exe", ["pnpm.cmd"], { encoding: "utf8", windowsHide: true, timeout: 5000 }),
  exists = existsSync,
} = {}) {
  if (platform !== "win32" || command !== "pnpm") return { command, args: [...args] };
  try {
    return { command: node, args: [resolve("pnpm/bin/pnpm.cjs"), ...args] };
  } catch {
    const found = findShim();
    if (found.error || (found.status != null && found.status !== 0)) throw new Error("pnpm command discovery failed");
    const shim = String(found.stdout ?? "").split(/\r?\n/u).find(Boolean);
    const entry = shim && win32.join(win32.dirname(shim), "node_modules", "pnpm", "bin", "pnpm.cjs");
    if (!entry || !exists(entry)) throw new Error("pnpm JavaScript entrypoint is unavailable");
    return { command: node, args: [entry, ...args] };
  }
}
