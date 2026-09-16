from pathlib import Path

path = Path("packages/desktop/scripts/workspace-tools.ts")
text = path.read_text(encoding="utf-8")

old_imports = '''import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
'''
new_imports = '''import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
'''
if text.count(old_imports) != 1:
    raise SystemExit("F01 import anchor drifted")
text = text.replace(old_imports, new_imports, 1)

old_block = '''function resolveBin(command: string, cwd: string): string {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const localBin = resolve(cwd, "node_modules", ".bin", `${command}${suffix}`);
  if (existsSync(localBin)) {
    return localBin;
  }

  return resolve(workspaceRoot, "node_modules", ".bin", `${command}${suffix}`);
}

export function runWorkspaceBin(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(resolveBin(command, cwd), args, {
      cwd,
      stdio: "inherit",
      env: process.env,
      // On Windows the resolved bin is a .cmd shim; Node refuses to spawn
      // .cmd/.bat without a shell (EINVAL) since CVE-2024-27980. resolveBin
      // produces an absolute, space-free path, so shell quoting is safe here.
      shell: process.platform === "win32",
    });
'''
new_block = '''/** Resolve the package's JavaScript entrypoint, not its platform shell shim. */
function resolveBin(command: string, cwd: string): string {
  const packageName = command === "tsc" ? "typescript" : command;
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve(`${packageName}/package.json`, { paths: [cwd, workspaceRoot] });
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const entry = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[command];
  if (typeof entry !== "string" || entry.length === 0) {
    throw new Error(`Package ${packageName} does not declare the ${command} executable`);
  }
  return resolve(dirname(manifestPath), entry);
}

export function runWorkspaceBin(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let entrypoint: string;
    try {
      entrypoint = resolveBin(command, cwd);
    } catch (error) {
      rejectPromise(error);
      return;
    }
    const child = spawn(process.execPath, [entrypoint, ...args], {
      cwd,
      stdio: "inherit",
      env: process.env,
      // User/project paths are argv data, never a second shell command.
      shell: false,
    });
'''
if text.count(old_block) != 1:
    raise SystemExit("F01 runWorkspaceBin anchor drifted")
text = text.replace(old_block, new_block, 1)
path.write_text(text, encoding="utf-8")

changeset = Path(".changeset/f01-correctness.md")
if changeset.exists():
    raise SystemExit("F01 changeset unexpectedly exists")
changeset.write_text(
    "---\n"
    '"@runfusion/fusion": patch\n'
    "---\n\n"
    "summary: Preserve literal build-tool arguments on Windows.\n"
    "category: fix\n"
    "dev: Run declared JavaScript tool entrypoints with Node instead of Windows shell shims.\n",
    encoding="utf-8",
)
