// Build with the Windows .NET SDK; no external packages. This launcher owns a
// kill-on-close job so an engine crash cannot leave a downloader tree running.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;

internal static class JobRunner {
  const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, INFINITE = 0xffffffff;
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static string Quote(string s) { // CommandLineToArgvW-compatible escaping.
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; }
    b.Append('\\',slashes*2); return b.Append('"').ToString();
  }
  static int Main(string[] args) {
    if(args.Length<2 || !int.TryParse(args[0],out int parentId)) return 2;
    IntPtr job=IntPtr.Zero, process=IntPtr.Zero, thread=IntPtr.Zero, memory=IntPtr.Zero;
    try {
      var parent=Process.GetProcessById(parentId);
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception();
      var limit=new EXTENDED_LIMIT(); limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size=Marshal.SizeOf<EXTENDED_LIMIT>();memory=Marshal.AllocHGlobal(size);Marshal.StructureToPtr(limit,memory,false);
      if(!SetInformationJobObject(job,9,memory,(uint)size)) throw new Win32Exception();
      var command=new StringBuilder();for(int i=1;i<args.Length;i++){if(i>1)command.Append(' ');command.Append(Quote(args[i]));}
      IntPtr output=GetStdHandle(-11), error=GetStdHandle(-12);
      if(output!=IntPtr.Zero && output!=new IntPtr(-1)) SetHandleInformation(output,1,1);
      if(error!=IntPtr.Zero && error!=new IntPtr(-1)) SetHandleInformation(error,1,1);
      var startup=new STARTUPINFO {cb=(uint)Marshal.SizeOf<STARTUPINFO>(),dwFlags=0x100,hStdInput=IntPtr.Zero,hStdOutput=output,hStdError=error};
      if(!CreateProcess(args[1],command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out var pi))throw new Win32Exception();
      process=pi.hProcess;thread=pi.hThread;
      if(!AssignProcessToJobObject(job,process)){TerminateProcess(process,1);throw new Win32Exception();}
      IntPtr ownedJob=job;
      _=Task.Run(()=>{try{parent.WaitForExit();TerminateJobObject(ownedJob,1);}catch{TerminateJobObject(ownedJob,1);}});
      _=Task.Run(()=>{try{Console.ReadLine();TerminateJobObject(ownedJob,1);}catch{TerminateJobObject(ownedJob,1);}});
      if(ResumeThread(thread)==0xffffffff)throw new Win32Exception();
      WaitForSingleObject(process,INFINITE);GetExitCodeProcess(process,out uint exitCode);
      TerminateJobObject(job,1);return unchecked((int)exitCode);
    } catch(Exception e) { Console.Error.WriteLine(e.GetType().Name);return 1; }
    finally {if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);if(thread!=IntPtr.Zero)CloseHandle(thread);if(process!=IntPtr.Zero)CloseHandle(process);if(job!=IntPtr.Zero)CloseHandle(job);}
  }
}
