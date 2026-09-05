import { afterEach, describe, expect, it, vi } from "vitest";
import { deploymentMaintenance, deploymentMaintenanceActive } from "../deployment-maintenance.js";
import { authenticateUpgradeRequest } from "../auth-middleware.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const folders: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder,{recursive:true}); });
function fence() {
  const folder=mkdtempSync(join(tmpdir(),"fusion-maintenance-test-"));folders.push(folder);
  const marker=join(folder,"active");writeFileSync(marker,"");
  vi.stubEnv("FUSION_DEPLOYMENT_MAINTENANCE_FILE",marker);
  vi.stubEnv("FUSION_DEPLOYMENT_CAPABILITY","test-only-capability");
}
function request(method: string,path: string,capability?: string) {
  const next=vi.fn();
  const res={status:vi.fn().mockReturnThis(),json:vi.fn(),setHeader:vi.fn()};
  deploymentMaintenance({method,path,get:()=>capability} as never,res as never,next);
  return {next,res};
}
describe("deployment maintenance fence",()=>{
  it("is inert without its opt-in marker",()=>{expect(deploymentMaintenanceActive()).toBe(false);expect(request("POST","/api/tasks").next).toHaveBeenCalled();});
  it.each([['GET','/'],['POST','/api/tasks'],['GET','/api/tasks'],['POST','/api/health'],['GET','/api/health/']])("blocks ordinary %s %s",(method,path)=>{fence();expect(request(method,path).res.status).toHaveBeenCalledWith(503);});
  it("permits only exact public health and advertises fence capability",()=>{fence();const x=request('GET','/api/health');expect(x.next).toHaveBeenCalled();expect(x.res.setHeader).toHaveBeenCalledWith('X-Fusion-Deployment-Fence','1');});
  it("permits the controller capability but not a wrong value",()=>{fence();expect(request('PUT','/api/settings','test-only-capability').next).toHaveBeenCalled();expect(request('PUT','/api/settings','wrong').res.status).toHaveBeenCalledWith(503);});
  it("refuses authenticated websocket upgrades while fenced",()=>{fence();expect(authenticateUpgradeRequest('daemon',{headers:{authorization:'Bearer daemon'}} as never)).toBe(false);});
});
