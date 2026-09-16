import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as workspace from "../build-workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsc = join(root, "node_modules/typescript/bin/tsc");

function fixture(t, incremental) {
  const dir = mkdtempSync(join(tmpdir(), "fusion missing output "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "plugins/fixture");
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "plugins/*"\n');
  writeFileSync(join(dir, ".gitignore"), "**/dist/\n**/*.tsbuildinfo\n.fusion/\n");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@fixture/plugin", private: true, type: "module", main: "./dist/index.js", scripts: { build: "tsc" } }));
  writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", outDir: "dist", rootDir: "src", types: [], skipLibCheck: true, incremental, ...(incremental ? { tsBuildInfoFile: "build.tsbuildinfo" } : {}) }, include: ["src"] }));
  writeFileSync(join(pkg, "src/index.ts"), 'export { value } from "./worker.js";\n');
  writeFileSync(join(pkg, "src/worker.ts"), "export const value = 42;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", timeout: 5000 });
  git("init"); git("config", "core.autocrlf", "false"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-m", "fixture");
  let builds = 0;
  function build() {
    return workspace.main({
      rootDir: dir,
      env: { ...process.env, CI: "false", FUSION_CLI_FULL_PACKAGE: "0" },
      spawnFn: (_cmd, args) => {
        assert.deepEqual(args, ["--filter", "@fixture/plugin", "build"]);
        builds += 1;
        return spawnSync(process.execPath, [tsc, "-p", join(pkg, "tsconfig.json")], { cwd: dir, encoding: "utf8", timeout: 10000 });
      },
    });
  }
  const load = () => execFileSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)}).then(m=>console.log(m.value))`], { cwd: dir, encoding: "utf8", timeout: 5000 }).trim();
  return { pkg, build, load, count: () => builds };
}

test("control: intact incremental output is built once and reused", { timeout: 15000 }, (t) => {
  const f = fixture(t, true);
  assert.equal(f.build(), 0); assert.equal(f.load(), "42");
  assert.equal(f.build(), 0); assert.equal(f.count(), 1);
});

test("control: nonincremental missing output is regenerated", { timeout: 15000 }, (t) => {
  const f = fixture(t, false);
  assert.equal(f.build(), 0); rmSync(join(f.pkg, "dist/worker.js"));
  assert.equal(f.build(), 0); assert.equal(f.load(), "42"); assert.equal(f.count(), 2);
});

for (const file of ["index.js", "worker.js"]) {
  test(`successful incremental rebuild recreates deleted ${file}`, { timeout: 15000 }, (t) => {
    const f = fixture(t, true);
    assert.equal(f.build(), 0); assert.equal(f.load(), "42");
    assert.equal(existsSync(join(f.pkg, "build.tsbuildinfo")), true);
    rmSync(join(f.pkg, "dist", file));
    assert.equal(f.build(), 0); assert.equal(f.count(), 2, "the real compiler must be invoked");
    assert.equal(existsSync(join(f.pkg, "dist", file)), true, "exit zero must not certify a still-missing required output");
    assert.equal(f.load(), "42");
  });
}