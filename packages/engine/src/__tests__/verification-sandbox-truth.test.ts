import { expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { runVerificationCommand } from "../execution/run-verification-tool.js";
import type { SandboxBackend } from "../sandbox/types.js";
it.each([
 ["control: ordinary success",{outcome:"success"},false,true,0,false,false],
 ["control: ordinary failure",{outcome:"non-zero-exit",exitCode:9},false,false,9,false,false],
 ["control: timeout cannot satisfy expected failure",{outcome:"timeout"},true,false,null,true,true],
 ["control: cancellation cannot satisfy expected failure",{outcome:"aborted"},true,false,null,false,true],
 ["control: spawn error cannot satisfy expected failure",{outcome:"spawn-error",error:new Error("synthetic")},true,false,null,false,false],
 ["signal termination cannot satisfy an expected failing command",{outcome:"non-zero-exit",exitCode:null,signal:"SIGTERM"},true,false,null,false,false],
])("%s",async(_name,outcome,expectFailure,success,exitCode,timedOut,killed)=>{
 const backend={prepare:vi.fn(),runStreaming:vi.fn().mockResolvedValue({stdout:"fixture",stderr:"",bufferOverflow:false,...outcome})} as unknown as SandboxBackend;
 const r=await runVerificationCommand({command:"fixture-command",cwd:tmpdir(),timeoutMs:1000,expectFailure:expectFailure as boolean,onHeartbeat:vi.fn(),sandboxBackend:backend});
 expect(backend.runStreaming).toHaveBeenCalledOnce();
 expect({success:r.success,exitCode:r.exitCode,timedOut:r.timedOut,killed:r.killed}).toEqual({success,exitCode,timedOut,killed});
});
