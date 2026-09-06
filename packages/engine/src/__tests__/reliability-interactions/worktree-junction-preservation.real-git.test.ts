import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NativeWorktreeBackend } from "../../worktree/worktree-backend.js";

describe("native removal preserves external junction targets", () => {
  const roots: string[] = [];
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", timeout: 15_000, windowsHide: true,
  }).trim();
  afterEach(async () => {
    // Node unlinks directory junctions rather than following their targets.
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "fusion junction regression "));
    roots.push(root);
    const repo = join(root, "repo");
    const checkout = join(root, "owned checkout");
    const external = join(root, "external dependencies");
    const source = join(root, "external source");
    for (const path of [repo, external, source]) await mkdir(path);
    git(repo, "init", "-b", "main");
    git(repo, "config", "user.name", "Fixture");
    git(repo, "config", "user.email", "fixture@example.invalid");
    git(repo, "config", "core.autocrlf", "false");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await writeFile(join(repo, "tracked.txt"), "original\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fixture");
    git(repo, "worktree", "add", "-b", "fixture", checkout);
    await writeFile(join(external, "dependency.txt"), "dependency survives\n");
    await writeFile(join(source, "source.txt"), "source survives\n");
    await symlink(source, join(external, "source-backlink"), process.platform === "win32" ? "junction" : "dir");
    await symlink(external, join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    return { repo, checkout, external, source };
  }
  it("removes the owned checkout without deleting bytes through a nested junction chain", async () => {
    const f = await fixture();
    await new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: f.checkout, force: true });
    expect(await readFile(join(f.external, "dependency.txt"), "utf8")).toBe("dependency survives\n");
    expect(await readFile(join(f.source, "source.txt"), "utf8")).toBe("source survives\n");
    expect(existsSync(f.checkout)).toBe(false);
    expect(git(f.repo, "worktree", "list", "--porcelain")).not.toContain("branch refs/heads/fixture");
  });
  it("retains dirty work and its junction when force is false", async () => {
    const f = await fixture();
    await writeFile(join(f.checkout, "tracked.txt"), "uncommitted work\n");
    await expect(new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: f.checkout, force: false })).rejects.toThrow();
    expect(await readFile(join(f.checkout, "tracked.txt"), "utf8")).toBe("uncommitted work\n");
    expect(await readFile(join(f.checkout, "node_modules", "dependency.txt"), "utf8")).toBe("dependency survives\n");
    expect(await readFile(join(f.source, "source.txt"), "utf8")).toBe("source survives\n");
  });
  it("safely removes clean ignored junctions without force", async () => {
    const f = await fixture();
    await new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: f.checkout, force: false });
    expect(await readFile(join(f.external, "dependency.txt"), "utf8")).toBe("dependency survives\n");
    expect(await readFile(join(f.source, "source.txt"), "utf8")).toBe("source survives\n");
    expect(existsSync(f.checkout)).toBe(false);
  });
  it.runIf(process.platform === "win32")("refuses an unignored junction even with force", async () => {
    const f = await fixture();
    await symlink(f.external, join(f.checkout, "untracked-link"), "junction");
    await expect(new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: f.checkout, force: true })).rejects.toThrow("preserving worktree");
    expect(await readFile(join(f.checkout, "node_modules", "dependency.txt"), "utf8")).toBe("dependency survives\n");
    expect(await readFile(join(f.checkout, "untracked-link", "dependency.txt"), "utf8")).toBe("dependency survives\n");
  });
  it.runIf(process.platform === "win32")("refuses a locked checkout before unlinking artifacts", async () => {
    const f = await fixture();
    git(f.repo, "worktree", "lock", f.checkout);
    await expect(new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: f.checkout, force: true })).rejects.toThrow("unlocked registered secondary checkout");
    expect(await readFile(join(f.checkout, "node_modules", "dependency.txt"), "utf8")).toBe("dependency survives\n");
  });
  it.runIf(process.platform === "win32")("refuses a junction supplied as the worktree root", async () => {
    const f = await fixture();
    const alias = join(f.repo, "checkout-alias");
    await symlink(f.checkout, alias, "junction");
    await expect(new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: alias, force: true })).rejects.toThrow("root is a junction");
    expect(await readFile(join(f.checkout, "tracked.txt"), "utf8")).toBe("original\n");
  });
  it.runIf(process.platform === "win32")("preserves indexed descendants with case-variant directory spelling", async () => {
    const f = await fixture();
    await unlink(join(f.checkout, "node_modules"));
    const indexed = join(f.checkout, "Node_Modules");
    await mkdir(indexed);
    await writeFile(join(indexed, "dependency.txt"), "dependency survives\n");
    git(f.checkout, "config", "core.ignorecase", "true");
    git(f.checkout, "add", "-f", "Node_Modules/dependency.txt");
    git(f.checkout, "commit", "-m", "synthetic tracked dependency");
    await rm(indexed, { recursive: true });
    await symlink(f.external, join(f.checkout, "node_modules"), "junction");
    expect(git(f.checkout, "status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    await expect(new NativeWorktreeBackend({ settings: {} }).remove({ rootDir: f.repo, worktreePath: f.checkout, force: true })).rejects.toThrow("not an untracked regenerable artifact");
    expect(await readFile(join(f.checkout, "node_modules", "dependency.txt"), "utf8")).toBe("dependency survives\n");
  });
});
