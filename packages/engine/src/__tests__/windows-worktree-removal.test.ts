import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { lstat, readdir, unlink } from "node:fs/promises";
import { prepareWindowsWorktreeRemoval } from "../worktree/windows-worktree-removal.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
vi.mock("node:fs/promises", () => ({ lstat: vi.fn(), readdir: vi.fn(), unlink: vi.fn() }));

describe.runIf(process.platform === "win32")("Windows cleanup fails closed on incomplete inspection", () => {
  const directory = { isSymbolicLink: () => false, isDirectory: () => true };
  beforeEach(() => vi.resetAllMocks());
  it.each(["EACCES", "EPERM", "EIO"])("refuses a root %s without invoking Git", async (code) => {
    vi.mocked(lstat).mockRejectedValue(Object.assign(new Error(code), { code }));
    await expect(prepareWindowsWorktreeRemoval("C:/repo", "C:/checkout")).rejects.toThrow(code);
    expect(execFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
  it("does not mistake a disappeared child for an absent worktree root", async () => {
    vi.mocked(lstat).mockResolvedValueOnce(directory as never).mockResolvedValueOnce(directory as never)
      .mockRejectedValueOnce(Object.assign(new Error("child vanished"), { code: "ENOENT" }))
      .mockRejectedValue(Object.assign(new Error("root inaccessible"), { code: "EACCES" }));
    vi.mocked(readdir).mockResolvedValue(["child"] as never);
    await expect(prepareWindowsWorktreeRemoval("C:/repo", "C:/checkout")).rejects.toThrow("child vanished");
    expect(execFile).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});
