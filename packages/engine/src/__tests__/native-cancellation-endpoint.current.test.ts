import { afterEach, expect, it } from "vitest";
import { createConnection, createServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NativeSandboxBackend } from "../sandbox/native.js";
const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true});});
function fixture(){const r=mkdtempSync(join(tmpdir(),"Fusion endpoint census "));roots.push(r);return r;}
async function bounded<T>(p:Promise<T>,ms:number,label:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p,new Promise<never>((_,j)=>{timer=setTimeout(()=>j(new Error(label)),ms);})]);}finally{clearTimeout(timer);}}
function killOwned(pid:number){if(!Number.isInteger(pid)||pid<1)return;try{if(process.platform==='win32')execFileSync('taskkill.exe',['/pid',String(pid),'/t','/f'],{stdio:'ignore',timeout:3000});else process.kill(pid,'SIGKILL');}catch{}}
async function challenge(port:number,nonce:string):Promise<string>{return await new Promise((r,j)=>{const s=createConnection({host:'127.0.0.1',port});let body='';s.setEncoding('utf8');s.setTimeout(1000);s.on('connect',()=>s.end(nonce));s.on('data',d=>{body+=d;});s.on('end',()=>{s.destroy();r(body);});s.on('error',e=>{s.destroy();if((e as NodeJS.ErrnoException).code==='ECONNREFUSED')r('closed');else j(e);});s.on('timeout',()=>{s.destroy();j(new Error('endpoint challenge timed out; inconclusive'));});});}
it("control: ordinary native streaming returns real output",async()=>{const cwd=fixture(),script=join(cwd,'ok.cjs');writeFileSync(script,"process.stdout.write('native-control');\n");const backend=new NativeSandboxBackend();try{expect(await backend.runStreaming(`\"${process.execPath}\" \"${script}\"`,{cwd,timeout:5000,maxBuffer:4096})).toMatchObject({outcome:'success',stdout:'native-control'});}finally{await backend.dispose();}});
it("cancellation acknowledgement cannot leave its nonce-identified descendant answering requests",async()=>{
 const cwd=fixture(),nonce=randomUUID(),abort=new AbortController();let owner=0,descendant=0,port=0;const sockets=new Set<Socket>();
 let ready!:(value:{owner:number,pid:number,port:number})=>void;
 const readiness=new Promise<{owner:number,pid:number,port:number}>(r=>{ready=r;});
 const server=createServer(s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.setEncoding('utf8');let body='';s.on('data',d=>{body+=d;});s.on('end',()=>{try{const x=JSON.parse(body);if(x.nonce===nonce&&Number.isInteger(x.pid)&&x.pid>0&&Number.isInteger(x.owner)&&x.owner>0&&Number.isInteger(x.port)&&x.port>0)ready(x);}catch{}s.destroy();});});
 await new Promise<void>((r,j)=>{server.once('error',j);server.listen(0,'127.0.0.1',r);});const observerPort=(server.address() as {port:number}).port;
 const child=join(cwd,'child.cjs'),parent=join(cwd,'parent.cjs');
 writeFileSync(child,`const net=require('node:net');const nonce=${JSON.stringify(nonce)};const server=net.createServer({allowHalfOpen:true},s=>{let b='';s.setEncoding('utf8');s.on('data',d=>b+=d);s.on('end',()=>s.end(b===nonce?'alive:'+nonce:'invalid'));});server.listen(0,'127.0.0.1',()=>{const s=net.createConnection(${observerPort},'127.0.0.1',()=>s.end(JSON.stringify({nonce,pid:process.pid,owner:process.ppid,port:server.address().port})));});\n`);
 writeFileSync(parent,`require('node:child_process').spawn(process.execPath,[${JSON.stringify(child)}],{stdio:'ignore'});setInterval(()=>{},1000);\n`);
 const backend=new NativeSandboxBackend();const pending=backend.runStreaming(`\"${process.execPath}\" \"${parent}\"`,{cwd,timeout:6000,maxBuffer:4096,signal:abort.signal});
 let settled=false;void pending.then(()=>{settled=true;},()=>{settled=true;});
 try{
  const x=await bounded(readiness,4000,'native readiness missing; inconclusive');({owner,pid:descendant,port}=x);
  expect(await challenge(port,nonce),'positive control: actual owned descendant responds').toBe('alive:'+nonce);
  abort.abort();const result=await bounded(pending,7000,'backend cancellation did not settle; inconclusive');expect(result.outcome).toBe('aborted');
  expect(await challenge(port,nonce),'continued nonce response proves live work, not merely a zombie PID').toBe('closed');
 }finally{
  abort.abort();killOwned(descendant);killOwned(owner);for(const s of sockets)s.destroy();
  await new Promise<void>(r=>server.close(()=>r()));
  if(!settled)await bounded(pending.catch(()=>{}),1500,'owned test process cleanup did not settle');
  await backend.dispose();
 }
});
