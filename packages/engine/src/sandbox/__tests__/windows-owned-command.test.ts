import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

import { NativeSandboxBackend } from "../native.js";

const backend = new NativeSandboxBackend();
const nodeCommand = (code: string) => `"${process.execPath}" -e "eval(Buffer.from('${Buffer.from(code).toString("base64")}','base64').toString())"`;
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function listenerAbsent(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(false); });
    socket.once("error", () => { socket.destroy(); resolve(true); });
    socket.setTimeout(1_000, () => { socket.destroy(); resolve(false); });
  });
}

// Native-only integration: real PIDs/listener are necessary to catch shell-only
// cancellation. Every fixture has a 60-second emergency lifetime independent of Fusion.
describe.skipIf(process.platform !== "win32")("Windows native command ownership", () => {
  it.each([0, 7, 124, 125])("preserves ordinary exit %i without fabricating timeout or cancellation", async (code) => {
    const result = await backend.runStreaming(nodeCommand(`process.stdout.write('space \\" quote');process.exit(${code})`), {
      cwd: process.cwd(), timeout: 5_000, maxBuffer: 1024,
    });
    expect(result).toMatchObject(code === 0 ? { outcome: "success" } : { outcome: "non-zero-exit", exitCode: code });
    expect(result.stdout).toBe('space " quote');
  });

  it("reports a real deadline separately from ordinary exit 124", async () => {
    const result = await backend.runStreaming(nodeCommand("setTimeout(()=>process.exit(99),60000)"), {
      cwd: process.cwd(), timeout: 200, maxBuffer: 1024,
    });
    expect(result).toMatchObject({ outcome: "timeout", timeoutMs: 200 });
  });

  it.each(["abort", "exit"] as const)("proves parent, detached child and listener gone after %s", async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "fusion job fixture with spaces "));
    const receiptPath = join(directory, "pids.json");
    const controller = new AbortController();
    const childCode = "const net=require('node:net');const s=net.createServer();setTimeout(()=>process.exit(99),60000);s.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({pid:process.pid,port:s.address().port})+'\\n'));";
    const parentCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');
setTimeout(()=>process.exit(99),60000);
const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{detached:true,stdio:['ignore','pipe','ignore'],windowsHide:true});
let text='';c.stdout.on('data',b=>{text+=b; if(text.includes('\\n')){const child=JSON.parse(text);fs.writeFileSync(${JSON.stringify(receiptPath)},JSON.stringify({parent:process.pid,...child}));${mode === "exit" ? "process.exit(0);" : ""}}});`;
    new Script(parentCode);
    new Script(childCode);
    const pending = backend.runStreaming(nodeCommand(parentCode), {
      cwd: directory, timeout: 10_000, maxBuffer: 1024, signal: controller.signal,
    });
    let finished: Awaited<typeof pending> | undefined;
    void pending.then((result) => { finished = result; });
    let receipt: { parent: number; pid: number; port: number } | undefined;
    try {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && !receipt && !finished) {
        try { receipt = JSON.parse(await readFile(receiptPath, "utf8")); } catch { await delay(50); }
      }
      expect(receipt, `fixture failed to start; result=${JSON.stringify(finished)}; evidence retained at ${directory}`).toBeDefined();
      if (mode === "abort") controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ outcome: mode === "abort" ? "aborted" : "success" });
      expect(alive(receipt!.parent)).toBe(false);
      expect(alive(receipt!.pid)).toBe(false);
      expect(await listenerAbsent(receipt!.port)).toBe(true);
    } finally {
      controller.abort();
      await pending;
      if (receipt && !alive(receipt.parent) && !alive(receipt.pid)) {
        await rm(directory, { recursive: true, force: true });
      } else {
        // Keep PID evidence for a failed containment test; emergency timers bound survivors.
        await writeFile(join(directory, "cleanup-unproven"), "Preserved fixture; inspect pids.json");
      }
    }
  }, 20_000);

  it("captures output in bytes and bounds overflow", async () => {
    const result = await backend.run(nodeCommand("process.stdout.write('x'.repeat(4096));setTimeout(()=>process.exit(99),60000)"), {
      cwd: process.cwd(), timeoutMs: 5_000, maxBuffer: 512,
    });
    expect(result.spawnError).toBeUndefined();
    expect(result.bufferExceeded).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBe(512);
    expect(result.exitCode).toBeNull();
  });
});
