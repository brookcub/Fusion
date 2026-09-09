/** FNXC:RequiredPgGate 2026-09-09-14:53:
 * An owned database gate must execute SQL assertions, never skip them because
 * a worker's brief reachability probe lost a race with machine load. Required
 * execution is a policy, not a claim that the database is healthy.
 */
export function selectPgTestExecution(
  env: Readonly<Record<string, string | undefined>>,
  probe: () => boolean,
): { available: boolean; enabled: boolean } {
  const required = env.FUSION_PG_TEST_REQUIRED === "1";
  if (required) {
    if (env.FUSION_PG_TEST_SKIP === "1") throw new Error("Required PostgreSQL tests cannot be skipped");
    let url: URL;
    try { url = new URL(env.FUSION_PG_TEST_URL_BASE ?? ""); }
    catch { throw new Error("Required PostgreSQL tests need an explicit database endpoint"); }
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname) {
      throw new Error("Required PostgreSQL tests need a PostgreSQL endpoint");
    }
  }
  const available = env.FUSION_PG_TEST_SKIP !== "1" && probe();
  return { available, enabled: required || available };
}
