import { execFile } from "node:child_process";
import { lstat, readdir, unlink } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const git = promisify(execFile);
const regenerable = new Set(["node_modules", "dist", "build", ".next", ".nuxt", ".cache", "coverage", ".turbo"]);

/** Git for Windows may follow directory junctions while removing a worktree.
 * Detach only verified ignored, regenerable links; all uncertainty preserves work.
 * This runs outside native remove's fallback catch, so refusal cannot authorize rm.
 */
export async function prepareWindowsWorktreeRemoval(rootDir: string, worktreePath: string): Promise<void> {
  if (process.platform !== "win32") return;
  const links: string[] = [];
  async function inspect(path: string, root = false): Promise<void> {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      if (root) throw new Error("preserving worktree: root is a junction or symbolic link");
      links.push(path);
    } else if (stat.isDirectory()) {
      for (const entry of await readdir(path)) await inspect(resolve(path, entry));
    } else if (root) {
      throw new Error("preserving worktree: root is not a directory");
    }
  }
  try { await lstat(worktreePath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  // A disappearance inside an existing tree is incomplete inspection, not root absence.
  await inspect(worktreePath, true);
  if (links.length === 0) return;
  const run = (cwd: string, args: string[]) => git("git", args, {
    cwd, encoding: "utf8", timeout: 15_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true,
  });
  const comparable = (path: string) => resolve(path).toLowerCase();
  const listing = await run(rootDir, ["worktree", "list", "--porcelain", "-z"]);
  const records = listing.stdout.split("\0\0").map((record) => record.split("\0"));
  const index = records.findIndex((record) => record.some((field) =>
    field.startsWith("worktree ") && comparable(field.slice(9)) === comparable(worktreePath)));
  if (index <= 0 || records[index].some((field) => field === "locked" || field.startsWith("locked "))) {
    throw new Error("preserving worktree: junction cleanup requires an unlocked registered secondary checkout");
  }
  // Check before unlinking even ignored entries. A refusal must preserve dirty work verbatim.
  const status = await run(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.stdout.trim()) throw new Error("preserving worktree: dirty checkout contains junctions");
  const tracked = (await run(worktreePath, ["ls-files", "-z"])).stdout.split("\0").filter(Boolean)
    .map((path) => path.replaceAll("\\", "/").toLowerCase());
  for (const link of links) {
    const local = relative(worktreePath, link);
    const normalized = local.split(sep).join("/").toLowerCase();
    if (isAbsolute(local) || local.startsWith(`..${sep}`) ||
        !local.split(sep).some((part) => regenerable.has(part)) ||
        tracked.some((path) => path === normalized || path.startsWith(`${normalized}/`))) {
      throw new Error("preserving worktree: junction is not an untracked regenerable artifact");
    }
    await run(worktreePath, ["check-ignore", "-q", "--", local]);
  }
  // All entries are admitted before the first mutation. unlink operates on the link, not its target.
  for (const link of links) {
    if (!(await lstat(link)).isSymbolicLink()) throw new Error("preserving worktree: junction changed during cleanup");
    await unlink(link);
  }
  links.length = 0;
  await inspect(worktreePath, true);
  if (links.length) throw new Error("preserving worktree: junction appeared during cleanup");
}
