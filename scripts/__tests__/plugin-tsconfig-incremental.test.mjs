import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const pluginBasePath = path.join(repoRoot, "plugins", "tsconfig.base.json");
const tscPath = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function runTsc(cwd) {
  execFileSync(process.execPath, [tscPath, "-p", "tsconfig.json"], {
    cwd,
    stdio: "pipe",
  });
}

function pluginConfig() {
  return {
    extends: "../tsconfig.base.json",
    compilerOptions: {
      rootDir: "src",
      outDir: "dist",
    },
    include: ["src/**/*"],
  };
}

test("plugin TypeScript cache is package-local, regenerates, and invalidates shared declaration changes", () => {
  const base = JSON.parse(readFileSync(pluginBasePath, "utf8"));
  assert.equal(base.compilerOptions.incremental, true);
  assert.equal(base.compilerOptions.tsBuildInfoFile, "${configDir}/dist/.tsbuildinfo");

  const root = mkdtempSync(path.join(tmpdir(), "fusion-plugin-tsbuildinfo-"));
  try {
    const pluginsDir = path.join(root, "plugins");
    writeJson(path.join(pluginsDir, "tsconfig.base.json"), {
      compilerOptions: {
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        declaration: true,
        incremental: true,
        tsBuildInfoFile: "${configDir}/dist/.tsbuildinfo",
        strict: true,
      },
    });
    writeJson(path.join(root, "node_modules", "@fixture", "shared", "package.json"), {
      name: "@fixture/shared",
      type: "module",
      exports: "./index.d.ts",
    });
    const sharedTypes = path.join(root, "node_modules", "@fixture", "shared", "index.d.ts");
    writeFileSync(sharedTypes, 'export declare const VALUE: "first";\n');

    const first = path.join(pluginsDir, "first");
    const second = path.join(pluginsDir, "second");
    for (const pluginDir of [first, second]) {
      writeJson(path.join(pluginDir, "tsconfig.json"), pluginConfig());
      mkdirSync(path.join(pluginDir, "src"), { recursive: true });
      writeFileSync(path.join(pluginDir, "src", "index.ts"), 'import { VALUE } from "@fixture/shared"; export const value = VALUE;\n', { encoding: "utf8", flush: true });
    }

    runTsc(first);
    runTsc(second);
    const firstInfo = path.join(first, "dist", ".tsbuildinfo");
    const secondInfo = path.join(second, "dist", ".tsbuildinfo");
    assert.notEqual(firstInfo, secondInfo);
    assert.match(readFileSync(path.join(first, "dist", "index.d.ts"), "utf8"), /"first"/);
    assert.match(readFileSync(path.join(second, "dist", "index.d.ts"), "utf8"), /"first"/);

    rmSync(path.join(first, "dist"), { recursive: true, force: true });
    runTsc(first);
    assert.ok(readFileSync(firstInfo, "utf8").length > 0, "missing dist must regenerate the package-local buildinfo");

    writeFileSync(sharedTypes, 'export declare const VALUE: "second";\n');
    runTsc(first);
    assert.match(readFileSync(path.join(first, "dist", "index.d.ts"), "utf8"), /"second"/, "shared declarations must invalidate a warm plugin program");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
