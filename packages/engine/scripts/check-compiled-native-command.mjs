import console from "node:console";
import process from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";

// FNXC:WindowsContainment 2026-09-09-13:23: Vitest/esbuild can hide imports that
// plain Node refuses. Validate the emitted runtime before packaging it.
const deadline = setTimeout(() => {
  console.error("Compiled native command import exceeded its deadline");
  process.exit(1);
}, 10_000);
try {
  const module = await import(new URL("../dist/sandbox/native.js", import.meta.url).href);
  if (typeof module.NativeSandboxBackend !== "function") throw new Error("Missing native backend export");
  console.log("Compiled native command runtime loads under plain Node");
} catch (error) {
  console.error("Compiled native command import failed:", error?.code ?? error?.name ?? "unknown");
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
}
