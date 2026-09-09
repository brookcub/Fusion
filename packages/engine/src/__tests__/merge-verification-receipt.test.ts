import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { Task, TaskStore } from "@fusion/core";
import { verifyAiMergeCandidate } from "../merge/merger-ai-verification.js";

const run = vi.hoisted(() => vi.fn());
vi.mock("../execution/verification-utils.js", () => ({ runVerificationCommand: run }));
beforeEach(() => run.mockReset().mockResolvedValue({ exitCode: 0, success: true }));

function fixture() {
  const task = { id: "FIXTURE", branch: "fusion/fixture", column: "in-review" } as Task;
  const settings = { testCommand: "node check-fixture.mjs" };
  const updateTaskAtomic = vi.fn(async (_id, updater) => { Object.assign(task, await updater(task)); return task; });
  const store = { getTask: async () => task, getSettings: async () => settings, updateTaskAtomic } as unknown as TaskStore;
  const check = () => verifyAiMergeCandidate({ store, taskId: task.id, mergeRoot: "fixture", branch: task.branch!,
    tipSha: "b".repeat(40), squashSha: "c".repeat(40), log: async () => {} },
  async (_cwd, args) => args[0] === "status" ? "" : args.includes("HEAD") ? "c".repeat(40) : "s".repeat(40));
  return { task, check, updateTaskAtomic };
}

it("durably binds successful check evidence to the candidate without copying command output", async () => {
  const f = fixture();
  run.mockResolvedValue({ exitCode: 0, success: true, output: "private-output" });
  await (await f.check())();
  expect(f.updateTaskAtomic).toHaveBeenCalledTimes(2);
  const receipt = (f.task.mergeDetails as any)?.verificationReceipts?.[0];
  expect(receipt).toMatchObject({ schema: 1, candidateSha: "c".repeat(40), sourceSha: "s".repeat(40),
    checks: [{ type: "test", commandSha256: createHash("sha256").update("node check-fixture.mjs").digest("hex"), exitCode: 0 }] });
  expect(JSON.stringify(receipt)).not.toContain("private-output");
  expect(JSON.stringify(receipt)).not.toContain("node check-fixture.mjs");
});

it.each([{ exitCode: 1, success: false }, { exitCode: 0, success: true, cached: true },
  { exitCode: 0, success: true, timedOut: true }])("persists failed evidence for rejected command %j", async (result) => {
  const f = fixture(); run.mockResolvedValue(result);
  await expect(f.check()).rejects.toThrow("verification failed");
  expect(f.updateTaskAtomic).toHaveBeenCalledTimes(2);
  expect(f.task.mergeDetails?.verificationReceipts?.[0]).toMatchObject({ outcome: "failed", completedAt: expect.any(String) });
});

it("refuses landing when receipt durability fails", async () => {
  const f = fixture(); f.updateTaskAtomic.mockRejectedValue(new Error("fixture durability unavailable"));
  await expect(f.check()).rejects.toThrow("durability unavailable");
});
