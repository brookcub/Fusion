param([Parameter(Mandatory=$true)][string]$Executable, [Parameter(Mandatory=$true)][string]$ArgumentsBase64, [Parameter(Mandatory=$true)][int]$TimeoutMs, [string]$CancelFile, [Parameter(Mandatory=$true)][string]$OutcomeFile)
$ErrorActionPreference = 'Stop'
# FNXC:TaskLogRegression 2026-09-06-13:47: Assign suspended children to a
# kill-on-close native job before they execute. A timeout owns descendants,
# including detached Vitest forks, and returns only after the job is empty.
Add-Type -ReferencedAssemblies 'System.Web.Extensions' -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.IO;
using System.Web.Script.Serialization;
public static class RegressionJob {
 public sealed class Completion { public int ExitCode; public string Outcome; public bool JobEmpty; }
 [StructLayout(LayoutKind.Sequential)] struct BasicLimits { public long a,b; public uint flags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h; }
 [StructLayout(LayoutKind.Sequential)] struct Counters { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Limits { public BasicLimits basic; public Counters io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential)] struct Accounting { public long a,b,c,d; public uint e,total,active,terminated; }
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup { public uint cb; public string reserved,desktop,title; public uint x,y,xsize,ysize,xchars,ychars,fill,flags; public ushort show,reserved2; public IntPtr bytes,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct Proc { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
 [DllImport("kernel32", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Limits value, uint size);
 [DllImport("kernel32", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting value, uint size, IntPtr returned);
 [DllImport("kernel32", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
 [DllImport("kernel32", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
 [DllImport("kernel32", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
 [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out Proc process);
 [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
 [DllImport("kernel32", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
 [DllImport("kernel32")] static extern IntPtr GetStdHandle(int kind);
 [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 static string Quote(string value) {
   var text = new StringBuilder("\""); int slashes=0;
   foreach (char c in value) { if(c=='\\') { slashes++; continue; } if(c=='\"') { text.Append('\\',slashes*2+1); text.Append(c); } else { text.Append('\\',slashes); text.Append(c); } slashes=0; }
   text.Append('\\',slashes*2); return text.Append('"').ToString();
 }
 public static Completion RunEncoded(string executable, string argumentsBase64, int timeout, string cancelFile) {
   string json=Encoding.UTF8.GetString(Convert.FromBase64String(argumentsBase64));
   string[] args=new JavaScriptSerializer().Deserialize<string[]>(json);
   if(args==null) throw new ArgumentException("arguments must decode to an array");
   return Run(executable,args,timeout,cancelFile);
 }
 public static Completion Run(string executable, string[] args, int timeout, string cancelFile) {
   IntPtr job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
   Proc process=new Proc(); bool assigned=false;
   try {
     Limits limits=new Limits(); limits.basic.flags=0x2000;
     Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Limits))));
     var command=new StringBuilder(Quote(executable)); foreach(string arg in args) command.Append(" ").Append(Quote(arg));
     Startup startup=new Startup(); startup.cb=(uint)Marshal.SizeOf(typeof(Startup)); startup.flags=0x100;
     startup.input=GetStdHandle(-10); startup.output=GetStdHandle(-11); startup.error=GetStdHandle(-12);
     Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,null,ref startup,out process));
     Check(AssignProcessToJobObject(job,process.process)); assigned=true;
     Check(ResumeThread(process.thread)!=0xffffffff);
     uint wait=258, code=0; int elapsed=0; string outcome="";
     while(timeout<0 || elapsed<timeout) {
       if(!String.IsNullOrEmpty(cancelFile) && File.Exists(cancelFile)) { code=125; outcome="cancelled"; break; }
       uint slice=(uint)(timeout<0 ? 50 : Math.Min(50,timeout-elapsed)); wait=WaitForSingleObject(process.process,slice);
       if(wait==0) { Check(GetExitCodeProcess(process.process,out code)); break; }
       if(wait!=258) throw new Win32Exception(); elapsed+=(int)slice;
     }
     if(wait==258 && outcome=="") { code=124; outcome="timeout"; }
     if(outcome=="") outcome="exit";
     Check(TerminateJobObject(job,124));
     for(int attempt=0;attempt<100;attempt++) {
       Accounting accounting; Check(QueryInformationJobObject(job,1,out accounting,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));
       if(accounting.active==0) return new Completion { ExitCode=unchecked((int)code), Outcome=outcome, JobEmpty=true };
       Thread.Sleep(20);
     }
     throw new Exception("owned job shutdown unproven");
   } finally {
     if(process.process!=IntPtr.Zero) { if(!assigned) TerminateProcess(process.process,125); CloseHandle(process.process); }
     if(process.thread!=IntPtr.Zero) CloseHandle(process.thread);
     CloseHandle(job);
   }
 }
}
'@
try {
  $application = (Get-Command $Executable -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
  # Preserve exact argv in the Base64 JSON until the native method decodes it;
  # PowerShell therefore cannot enumerate or rebind individual arguments.
  $completion = [RegressionJob]::RunEncoded($application, $ArgumentsBase64, $TimeoutMs, $CancelFile)
  [IO.File]::WriteAllText($OutcomeFile, ('{"outcome":"' + $completion.Outcome + '","jobEmpty":true,"exitCode":' + $completion.ExitCode + '}'))
  exit $completion.ExitCode
} catch {
  try { [IO.File]::WriteAllText($OutcomeFile, '{"outcome":"helper-failure","jobEmpty":false}') } catch {}
  [Console]::Error.WriteLine("owned command setup or shutdown failed: $($_.Exception.Message)"); exit 125
}
