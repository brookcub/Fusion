import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";

// FNXC:RequiredPgGate 2026-09-09-14:53: Model a failed synchronous discovery
// probe, while the owning gate supplies a real private database for SQL proof.
vi.mock("node:worker_threads", () => ({
  Worker: class {
    postMessage(message: { buf: SharedArrayBuffer }): void {
      Atomics.store(new Int32Array(message.buf), 0, 2);
    }
    async terminate(): Promise<number> { return 0; }
  },
}));

import { PG_AVAILABLE, PG_TEST_URL_BASE, pgDescribe } from "../../__test-utils__/pg-test-harness.js";

const requiredDescribe = process.env.FUSION_PG_TEST_REQUIRED === "1" ? pgDescribe : describe.skip;
requiredDescribe("required PG lane survives a false-negative discovery probe", () => {
  it("executes real SQL without labelling the probe healthy", async () => {
    expect(PG_AVAILABLE).toBe(false);
    const url = new URL(PG_TEST_URL_BASE);
    url.pathname = "/postgres";
    const sql = postgres(url.toString(), { connect_timeout: 2, max: 1 });
    try {
      const rows = await sql`select 1 as proof`;
      expect(rows[0]?.proof).toBe(1);
    } finally { await sql.end({ timeout: 2 }); }
  });
});
