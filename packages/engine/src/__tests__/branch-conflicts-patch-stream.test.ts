import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const state = vi.hoisted(() => ({ calls: [] as string[][], failHistory: false }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const wrapped = (file: string, args: string[], options: object, callback: (...args: any[]) => void) => {
    state.calls.push(args);
    if (args[0] === "cherry" || (state.failHistory && args[0] === "log" && args.includes("--patch"))) {
      queueMicrotask(() => callback(new Error("injected probe failure"), "", ""));
      return {} as ReturnType<typeof actual.execFile>;
    }
    return actual.execFile(file, args, options, callback);
  };
  Object.defineProperty(wrapped, Symbol.for("nodejs.util.promisify.custom"), {
    value: (file: string, args: string[], options: object) => new Promise((resolve, reject) => {
      wrapped(file, args, options, (error, stdout, stderr) => error ? reject(error) : resolve({ stdout, stderr }));
    }),
  });
  return { ...actual, execFile: wrapped };
});
import { classifyForeignCommits } from "../execution/branch-conflicts.js";

const roots: string[] = [];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10000 }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fusion batch patch ids ")); roots.push(root);
  git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  await writeFile(join(root, "base"), "base\n"); git(root, "add", "."); git(root, "commit", "-m", "root");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "-b", "feature");
  await writeFile(join(root, "foreign"), "foreign\n"); git(root, "add", "."); git(root, "commit", "-m", "fix(FN-4001): foreign");
  const foreign = git(root, "rev-parse", "HEAD");
  git(root, "checkout", "main");
  // Make the upstream cherry-pick a different commit with an equivalent patch.
  for (let i = 0; i < 5; i++) {
    await writeFile(join(root, `unrelated-${i}`), `${i}\n`); git(root, "add", "."); git(root, "commit", "-m", `unrelated ${i}`);
  }
  git(root, "cherry-pick", foreign);
  expect(git(root, "rev-parse", "HEAD")).not.toBe(foreign);
  return { repoDir: root, branchName: "feature", baseSha: base, mainRef: "main",
    foreignCommits: [{ sha: foreign, subject: "fix(FN-4001): foreign", foreignTaskId: "FN-4001" }] };
}
beforeEach(() => { state.calls.length = 0; state.failHistory = false; });
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("native patch-id fallback", () => {
  it("classifies equivalent history with one batched history process and one patch-id process", async () => {
    const input = await fixture();
    const result = await classifyForeignCommits(input);
    expect(result.alreadyUpstream).toEqual(input.foreignCommits); expect(result.unique).toEqual([]);
    expect(state.calls.filter((args) => args[0] === "log" && args.includes("--patch"))).toHaveLength(1);
    // One patch-id for the entire upstream history and one for the candidate, not one per ancestor.
    expect(state.calls.filter((args) => args[0] === "patch-id")).toHaveLength(2);
    expect(state.calls.filter((args) => args[0] === "show")).toHaveLength(1);
  });
  it("does not turn failed history inspection into evidence that a foreign commit can be dropped", async () => {
    const input = await fixture(); state.failHistory = true;
    const result = await classifyForeignCommits(input);
    expect(result.alreadyUpstream).toEqual([]); expect(result.unique).toEqual(input.foreignCommits);
  });
});
