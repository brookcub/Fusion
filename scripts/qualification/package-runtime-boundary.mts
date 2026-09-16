import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolveClaudeCliExtensionFromModuleUrl } from "../../packages/cli/src/commands/claude-cli-extension.ts";

const repoRoot = resolve(process.cwd());
const cliDir = join(repoRoot, "packages", "cli");
const scratch = mkdtempSync(join(tmpdir(), "fusion packaged runtime & isolated "));
const packDir = join(scratch, "packed");
const installDir = join(scratch, "external install & cwd");
const isolatedHome = join(scratch, "isolated home");
mkdirSync(packDir, { recursive: true });
mkdirSync(installDir, { recursive: true });
mkdirSync(isolatedHome, { recursive: true });

const pnpmEntrypoint = process.env.npm_execpath;
assert.ok(pnpmEntrypoint, "qualification must run under pnpm so package-manager invocation is literal argv");
const isolatedEnv = {
  ...process.env,
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  FUSION_HOME: join(isolatedHome, ".fusion"),
};

function runPnpm(args: string[], cwd: string) {
  const result = spawnSync(process.execPath, [pnpmEntrypoint!, ...args], {
    cwd,
    env: isolatedEnv,
    encoding: "utf8",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `pnpm ${args.join(" ")} was terminated`);
  assert.equal(result.status, 0, `pnpm ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

try {
  // Build output is produced by the workflow before this probe. Pack exactly that publishable tree.
  runPnpm(["--dir", cliDir, "pack", "--pack-destination", packDir], repoRoot);
  const tarballs = readdirSync(packDir).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, `expected one CLI tarball, found ${tarballs.join(", ")}`);
  const tarball = join(packDir, tarballs[0]!);

  writeFileSync(join(installDir, "package.json"), JSON.stringify({ name: "fusion-package-boundary-probe", private: true }, null, 2));
  runPnpm(["add", "--ignore-workspace", tarball], installDir);

  const installedRoot = join(installDir, "node_modules", "@runfusion", "fusion");
  assert.ok(existsSync(installedRoot), "packed @runfusion/fusion did not install externally");
  const installedReal = realpathSync(installedRoot);
  const repoReal = realpathSync(repoRoot);
  assert.ok(!installedReal.startsWith(repoReal + (process.platform === "win32" ? "\\" : "/")), `installed package leaked back into repo: ${installedReal}`);

  const installedBin = join(installedRoot, "dist", "bin.js");
  assert.ok(existsSync(installedBin), "installed CLI dist/bin.js is missing");
  const cliVersion = spawnSync(process.execPath, [installedBin, "--version"], {
    cwd: installDir,
    env: isolatedEnv,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(cliVersion.error, undefined, `installed CLI failed to spawn: ${cliVersion.error?.message}`);
  assert.equal(cliVersion.signal, null, "installed CLI --version hung or was terminated");
  assert.equal(cliVersion.status, 0, `installed CLI --version failed\n${cliVersion.stdout}\n${cliVersion.stderr}`);

  // F25: exercise Fusion's canonical resolver against the *installed* module topology.
  const resolution = resolveClaudeCliExtensionFromModuleUrl(pathToFileURL(installedBin).href);
  assert.equal(resolution.status, "ok", `canonical Claude extension resolution failed: ${JSON.stringify(resolution)}`);
  assert.ok(resolution.status === "ok");
  const stagedPiRoot = join(installedRoot, "dist", "pi-claude-cli");
  assert.ok(realpathSync(resolution.path).startsWith(realpathSync(stagedPiRoot)), `resolver escaped staged dist/pi-claude-cli: ${resolution.path}`);
  assert.ok(existsSync(resolution.path), `resolved Claude extension is missing: ${resolution.path}`);
  const stagedPiManifest = JSON.parse(readFileSync(join(stagedPiRoot, "package.json"), "utf8"));
  assert.equal(resolution.packageVersion, stagedPiManifest.version);
  assert.equal(resolve(dirname(join(stagedPiRoot, "package.json")), stagedPiManifest.pi.extensions[0]), resolution.path);

  // F32: packaged runtime + bridge assets must be present, fresh, importable, and backed by a platform package.
  const pluginRoot = join(installedRoot, "dist", "plugins", "fusion-plugin-claude-runtime");
  const runtimeBundle = join(pluginRoot, "bundled.js");
  const stagedLauncher = join(pluginRoot, "bridge", "node_modules", "claude-code-cli-acp", "bin", "claude-code-cli-acp.js");
  const stagedLauncherManifestPath = join(pluginRoot, "bridge", "node_modules", "claude-code-cli-acp", "package.json");
  for (const required of [runtimeBundle, stagedLauncher, stagedLauncherManifestPath, join(pluginRoot, "manifest.json")]) {
    assert.ok(existsSync(required), `required packaged runtime artifact is missing: ${required}`);
  }

  const sourceArtifacts = [
    [join(cliDir, "dist", "pi-claude-cli", "index.ts"), join(stagedPiRoot, "index.ts")],
    [join(cliDir, "dist", "plugins", "fusion-plugin-claude-runtime", "bundled.js"), runtimeBundle],
    [join(cliDir, "dist", "plugins", "fusion-plugin-claude-runtime", "bridge", "node_modules", "claude-code-cli-acp", "bin", "claude-code-cli-acp.js"), stagedLauncher],
  ] as const;
  for (const [built, installed] of sourceArtifacts) {
    assert.ok(existsSync(built), `fresh build artifact is missing before pack: ${built}`);
    assert.equal(sha(installed), sha(built), `packed artifact is stale or differs from fresh build: ${installed}`);
  }

  const importedRuntime = await import(pathToFileURL(runtimeBundle).href + `?qualification=${Date.now()}`);
  assert.ok(Object.keys(importedRuntime).length > 0, "installed Claude runtime bundle imported but exposed no module surface");

  const installedAcpManifestPath = join(installDir, "node_modules", "claude-code-cli-acp", "package.json");
  assert.ok(existsSync(installedAcpManifestPath), "published Fusion dependency claude-code-cli-acp is missing after external install");
  const installedAcpManifest = JSON.parse(readFileSync(installedAcpManifestPath, "utf8"));
  const stagedAcpManifest = JSON.parse(readFileSync(stagedLauncherManifestPath, "utf8"));
  assert.equal(stagedAcpManifest.version, installedAcpManifest.version, "staged ACP launcher version differs from installed dependency");

  const optionalNames = Object.keys(installedAcpManifest.optionalDependencies ?? {});
  assert.ok(optionalNames.length > 0, "claude-code-cli-acp declares no optional native packages to verify");
  const installedNative = optionalNames
    .map((name) => ({ name, manifest: join(installDir, "node_modules", ...name.split("/"), "package.json") }))
    .find((candidate) => existsSync(candidate.manifest));
  assert.ok(installedNative, `no platform-native ACP optional dependency installed; candidates=${optionalNames.join(",")}`);
  const nativeManifest = JSON.parse(readFileSync(installedNative!.manifest, "utf8"));
  const nativeRoot = dirname(installedNative!.manifest);
  const binDecl = typeof nativeManifest.bin === "string" ? nativeManifest.bin : Object.values(nativeManifest.bin ?? {})[0];
  const loadEntry = binDecl ?? nativeManifest.main;
  assert.ok(typeof loadEntry === "string" && loadEntry.length > 0, `native ACP package ${installedNative!.name} has no loadable entry`);
  assert.ok(existsSync(resolve(nativeRoot, loadEntry)), `native ACP entry is missing: ${resolve(nativeRoot, loadEntry)}`);

  // Execute the staged launcher from the external cwd. A non-zero doctor result is acceptable
  // when Claude itself is absent; module/native-loader failures are not.
  const doctor = spawnSync(process.execPath, [stagedLauncher, "doctor"], {
    cwd: installDir,
    env: isolatedEnv,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(doctor.error, undefined, `staged ACP launcher failed to spawn: ${doctor.error?.message}`);
  assert.equal(doctor.signal, null, "staged ACP launcher doctor hung or was terminated");
  const doctorText = `${doctor.stdout ?? ""}\n${doctor.stderr ?? ""}`;
  assert.doesNotMatch(doctorText, /MODULE_NOT_FOUND|Cannot find module|ERR_MODULE_NOT_FOUND|dlopen|not a valid Win32 application/i);

  console.log(JSON.stringify({
    ok: true,
    platform: `${process.platform}-${process.arch}`,
    installedRoot: installedReal,
    claudeExtension: resolution.path,
    claudeExtensionVersion: resolution.packageVersion,
    runtimeBundle,
    acpVersion: installedAcpManifest.version,
    nativePackage: installedNative!.name,
    doctorStatus: doctor.status,
  }, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
