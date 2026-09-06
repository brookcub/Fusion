/**
 * FNXC:AIMergeVerification 2026-09-06-02:38:
 * A merger must not duplicate engine-owned verification via familiar shell commands.
 * This recognizes ordinary command positions, preserving quoted Git/search prose.
 * It is an operational duplication guard, NOT a shell sandbox: dynamic variables,
 * interpreter-generated commands and arbitrary custom scripts are not interpreted.
 */
function simpleCommands(command: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [], word = "", quote = "";
  const endWord = () => { if (word) words.push(word); word = ""; };
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quote) {
      if (char === quote) quote = "";
      else if (char === "\\" && quote === '"' && command[i + 1] === '"') word += command[++i];
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (";&|\n".includes(char)) { endWord(); if (words.length) commands.push(words); words = []; }
    else if (/\s/.test(char)) endWord();
    else word += char;
  }
  endWord();
  if (words.length) commands.push(words);
  return commands;
}

const executable = (word = "") => word.replace(/\\/g, "/").split("/").pop()!.toLowerCase().replace(/\.(cmd|exe|bat)$/, "");
const check = /^(?:test|typecheck|type-check|lint|build|verify|check)(?::.*)?$/i;
const direct = /^(?:vitest|jest|tsc|eslint|pytest|mocha)$/i;

export function isMergerVerificationCommand(command: string): boolean {
  return simpleCommands(command).some((original) => {
    const words = [...original];
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "") || ["env", "command", "rtk"].includes(words[0])) words.shift();
    const bin = executable(words.shift());
    if (direct.test(bin)) return true;
    if (bin === "node") return words.includes("--test") || words.some((word) => /^(?:run-merge-gate|verify-fast|test-gate|test-changed)\.(?:mjs|js)$/.test(executable(word)));
    if (!["pnpm", "npm", "yarn", "bun", "npx"].includes(bin)) return false;
    let index = 0;
    while (words[index]?.startsWith("-")) {
      const option = words[index++];
      if (["--filter", "-F", "--dir", "-C", "--cwd", "--prefix", "--workspace"].includes(option)) index++;
    }
    let action = words[index++];
    if (action === "run" || action === "run-script" || action === "exec" || action === "dlx") {
      while (words[index]?.startsWith("-")) index++;
      action = words[index];
    }
    return check.test(action ?? "") || direct.test(executable(action));
  });
}
