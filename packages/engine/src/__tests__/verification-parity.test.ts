import { expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import { runVerificationCommand } from "../execution/run-verification-tool.js";
it.each([[0,false],[7,false],[7,true],[0,true]])("the same exit %i and expectFailure=%s has the same meaning in both execution modes",async(code,expectFailure)=>{
 const command=`"${process.execPath}" -e "process.exit(${code})"`;
 const common={command,cwd:tmpdir(),timeoutMs:5000,expectFailure,onHeartbeat:vi.fn()};
 const direct=await runVerificationCommand(common);
 const backend:any={prepare:vi.fn(),runStreaming:vi.fn(async()=>({stdout:"",stderr:"",bufferOverflow:false,...(code===0?{outcome:"success"}:{outcome:"non-zero-exit",exitCode:code,signal:null})}))};
 const sandbox=await runVerificationCommand({...common,sandboxBackend:backend});
 expect(direct.exitCode).toBe(code);expect(sandbox.exitCode).toBe(code);expect(direct.timedOut).toBe(false);
 expect(direct.success,"backend selection must not redefine the same result").toBe(sandbox.success);
});
it("actual command timeout cannot become verification success merely because failure was expected",async()=>{
 const command=`"${process.execPath}" -e "setTimeout(()=>process.exit(0),500)"`;
 const r=await runVerificationCommand({command,cwd:tmpdir(),timeoutMs:100,expectFailure:true,onHeartbeat:vi.fn()});
 expect(r.timedOut,"control: the actual verification timeout fired").toBe(true);expect(r.success).toBe(false);
});