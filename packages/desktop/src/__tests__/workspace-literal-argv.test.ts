import { afterEach, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkspaceBin, workspaceRoot } from "../../scripts/workspace-tools";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

it("positive control: the existing TypeScript entrypoint can run", async () => {
  await expect(runWorkspaceBin("tsc", ["--version"], join(workspaceRoot, "packages/core"))).resolves.toBeUndefined();
});

it("preserves a spaced and metacharacter project path as one literal argument", async () => {
  const dir = mkdtempSync(join(tmpdir(), "Fusion argv & literal ")); roots.push(dir);
  const config = join(dir, "project config.json");
  writeFileSync(config, JSON.stringify({ compilerOptions: { noEmit: true, types: [], skipLibCheck: true }, files: ["input.ts"] }));
  writeFileSync(join(dir, "input.ts"), "export const value: number = 1;\n");
  await expect(runWorkspaceBin("tsc", ["--project", config], join(workspaceRoot, "packages/core"))).resolves.toBeUndefined();
});

it("rejects a compiler failure instead of reporting success", async () => {
  const dir = mkdtempSync(join(tmpdir(), "Fusion failing compiler ")); roots.push(dir);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { noEmit: true, types: [], skipLibCheck: true }, files: ["input.ts"] }));
  writeFileSync(join(dir, "input.ts"), 'export const value: number = "invalid";\n');
  await expect(runWorkspaceBin("tsc", ["--project", join(dir, "tsconfig.json")], join(workspaceRoot, "packages/core"))).rejects.toThrow(/exited with code/);
});

it("rejects a missing executable without shell fallback", async () => {
  await expect(runWorkspaceBin("fusion-tool-that-does-not-exist", [], join(workspaceRoot, "packages/core"))).rejects.toBeDefined();
});