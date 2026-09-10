/**
 * Native Claude CLI/subscription child-auth policy. This pure module is also
 * bundled into dashboard probes so status and execution have one authority.
 * @param {NodeJS.ProcessEnv} [source]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildNativeClaudeEnv(source = globalThis.process.env) {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].includes(key.toUpperCase()),
  ));
}
