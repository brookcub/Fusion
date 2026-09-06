import { describe, expect, it, vi } from "vitest";
import { isMergerVerificationCommand } from "../merge/merger-verification-command-policy.js";
import { wrapToolsWithBashContainment } from "../pi.js";

describe("merger engine-owned verification commands", () => {
  it.each([
    "pnpm lint", "pnpm typecheck", "pnpm build", "pnpm test",
    "pnpm --filter @fusion/cli test", "pnpm -r run build", "npm run test:gate",
    "pnpm exec vitest run focused.test.ts", "tsc --noEmit", "git status && pnpm test",
    'git status; pnpm --dir "path with spaces" run lint', "git status\npnpm test",
    "rtk pnpm test", "CI=1 pnpm test", "pnpm --filter=@fusion/engine test",
    '"C:\\Program Files\\nodejs\\pnpm.cmd" test', "node scripts/run-merge-gate.mjs",
  ])("refuses recognizable duplicate launch: %s", async (command) => {
    expect(isMergerVerificationCommand(command)).toBe(true);
    const execute = vi.fn();
    const [tool] = wrapToolsWithBashContainment([{ name: "bash", execute } as never], "merger");
    const result = await (tool.execute as any)("call", { command });
    expect(result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    "git status", "git merge --squash fusion/task", "git add -A",
    'git commit -m "fix pnpm test; build & lint commands"', "rg 'pnpm test' package.json",
    "cat package.json", "git diff -- build.ts", "pnpm install --frozen-lockfile",
    "pnpm --version", "pnpm list", "pnpm exec rg 'pnpm test' package.json",
  ])("preserves non-verification commands unchanged: %s", async (command) => {
    expect(isMergerVerificationCommand(command)).toBe(false);
    const execute = vi.fn(async () => ({ passedThrough: true }));
    const [tool] = wrapToolsWithBashContainment([{ name: "bash", execute } as never], "merger");
    expect(await (tool.execute as any)("call", { command })).toEqual({ passedThrough: true });
    expect(execute).toHaveBeenCalledExactlyOnceWith("call", { command });
  });
  it("does not restrict executor verification", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const [tool] = wrapToolsWithBashContainment([{ name: "bash", execute } as never], "executor");
    await (tool.execute as any)("call", { command: "pnpm test" });
    expect(execute).toHaveBeenCalledOnce();
  });
});
