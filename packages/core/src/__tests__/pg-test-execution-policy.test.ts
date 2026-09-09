import { describe, expect, it } from "vitest";
import { selectPgTestExecution } from "../__test-utils__/pg-test-execution-policy.js";

describe("required PostgreSQL test execution", () => {
  const required = { FUSION_PG_TEST_REQUIRED: "1", FUSION_PG_TEST_URL_BASE: "postgresql://127.0.0.1:15432" };
  it("keeps mandatory tests enabled without fabricating availability", () => {
    expect(selectPgTestExecution(required, () => false)).toEqual({ available: false, enabled: true });
    expect(selectPgTestExecution(required, () => true)).toEqual({ available: true, enabled: true });
  });
  it("preserves optional discovery and explicit skip", () => {
    expect(selectPgTestExecution({}, () => false)).toEqual({ available: false, enabled: false });
    expect(selectPgTestExecution({}, () => true)).toEqual({ available: true, enabled: true });
    expect(selectPgTestExecution({ FUSION_PG_TEST_SKIP: "1" }, () => { throw Error("must not probe"); }))
      .toEqual({ available: false, enabled: false });
  });
  it("refuses contradictory or implicit required-test configuration", () => {
    expect(() => selectPgTestExecution({ ...required, FUSION_PG_TEST_SKIP: "1" }, () => true)).toThrow();
    for (const endpoint of [undefined, "", "invalid", "https://localhost"]) {
      expect(() => selectPgTestExecution({ ...required, FUSION_PG_TEST_URL_BASE: endpoint }, () => true)).toThrow();
    }
  });
});
