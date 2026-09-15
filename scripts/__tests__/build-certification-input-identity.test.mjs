import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as workspace from "../build-workspace.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tsc = join(root, "node_modules/typescript/bin/tsc");

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "fusion cert identity "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pkg = join(dir, "plugins/fixture");
  mkdirSync(join(pkg, "src"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ private: true }));
  writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "plugins/*"\n');
  writeFileSync(join(dir, ".gitignore"), "**/dist/\n.fusion/\n");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@fixture/plugin", private: true, type: "module", main: "./dist/index.js", scripts: { build: "tsc" } }));
  writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", outDir: "dist", rootDir: "src", types: [], skipLibCheck: true }, include: ["src"] }));
  writeFileSync(join(pkg, "src/index.ts"), 'export { value } from "./worker.js";\n');
  writeFileSync(join(pkg, "src/worker.ts"), "export const value = 42;\n");
  const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe", timeout: 5000 });
  git("init"); git("config", "core.autocrlf", "false"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid"); git("add", "."); git("commit", "-m", "fixture");
  let builds = 0;
  function build(afterCompile) {
    return workspace.main({
      rootDir: dir,
      env: { ...process.env, CI: "false", FUSION_CLI_FULL_PACKAGE: "0" },
      spawnFn: (_cmd, args) => {
        assert.deepEqual(args, ["--filter", "@fixture/plugin", "build"]);
        builds += 1;
        const result = spawnSync(process.execPath, [tsc, "-p", join(pkg, "tsconfig.json")], { cwd: dir, encoding: "utf8", timeout: 10000 });
        assert.equal(result.error, undefined);
        if (result.status === 0) afterCompile?.();
        return result;
      },
    });
  }
  const load = () => execFileSync(process.execPath, ["--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)}).then(m=>console.log(m.value))`], { cwd: dir, encoding: "utf8", timeout: 5000 }).trim();
  return { pkg, build, load, count: () => builds };
}

test("control: unchanged source reuses certification after one real compile", { timeout: 15000 }, (t) => {
  const f = fixture(t);
  assert.equal(f.build(), 0); assert.equal(f.load(), "42");
  assert.equal(f.build(), 0); assert.equal(f.count(), 1);
});

test("source changed after compiler consumption is not certified as already built", { timeout: 15000 }, (t) => {
  const f = fixture(t);
  assert.equal(f.build(() => writeFileSync(join(f.pkg, "src/worker.ts"), "export const value = 99;\n")), 0);
  assert.equal(f.load(), "42", "control: first artifact contains the input actually compiled");
  assert.match(readFileSync(join(f.pkg, "src/worker.ts"), "utf8"), /99/);
  assert.equal(f.build(), 0);
  assert.equal(f.count(), 2, "later source must not reuse certification of the previous artifact");
  assert.equal(f.load(), "99");
});
