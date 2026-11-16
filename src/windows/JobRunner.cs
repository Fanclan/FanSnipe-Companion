// Build with the Windows .NET SDK; no external packages. This launcher owns a
// kill-on-close job so an engine crash cannot leave a downloader tree running.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

internal static class JobRunner {
  const uint CREATE_SUSPENDED = 0x4, CREATE_NO_WINDOW = 0x08000000, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000, INFINITE = 0xffffffff;
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT { public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT { public BASIC_LIMIT BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct STARTUPINFO { public uint cb; public string lpReserved, lpDesktop, lpTitle; public uint dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public ushort wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_ACCOUNTING { public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public uint dwProcessId, dwThreadId; }
  [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)] static extern int sqlite3_open_v2([MarshalAs(UnmanagedType.LPUTF8Str)] string path, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)] static extern int sqlite3_exec(IntPtr db, [MarshalAs(UnmanagedType.LPUTF8Str)] string sql, IntPtr callback, IntPtr context, IntPtr error);
  [DllImport("winsqlite3.dll", CallingConvention=CallingConvention.Cdecl)] static extern int sqlite3_close(IntPtr db);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr info, uint length, out uint returnLength);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr procAttrs, IntPtr threadAttrs, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string filename, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static bool WaitForEmptyJob(IntPtr job) {
    int size=Marshal.SizeOf<BASIC_ACCOUNTING>();IntPtr accounting=Marshal.AllocHGlobal(size);
    try {while(true){if(QueryInformationJobObject(job,1,accounting,(uint)size,out _)){var state=Marshal.PtrToStructure<BASIC_ACCOUNTING>(accounting);if(state.ActiveProcesses==0)return true;}Thread.Sleep(25);}}
    finally {Marshal.FreeHGlobal(accounting);}
  }
  static string Quote(string s) { // CommandLineToArgvW-compatible escaping.
    var b=new StringBuilder("\""); int slashes=0;
    foreach(char c in s) { if(c=='\\') { slashes++; continue; } if(c=='\"') { b.Append('\\',slashes*2+1); b.Append(c); } else { b.Append('\\',slashes); b.Append(c); } slashes=0; }
    b.Append('\\',slashes*2); return b.Append('"').ToString();
  }
  static int Main(string[] args) {
    if(args.Length<3 || !int.TryParse(args[0],out int parentId)) return 2;
    IntPtr job=IntPtr.Zero, process=IntPtr.Zero, thread=IntPtr.Zero, memory=IntPtr.Zero, input=IntPtr.Zero, lease=IntPtr.Zero;
    try {
      var parent=Process.GetProcessById(parentId);var parentHandle=parent.Handle;
      if(sqlite3_open_v2(args[1],out lease,2,IntPtr.Zero)!=0)throw new Exception("Lease unavailable");
      if(sqlite3_exec(lease,"PRAGMA busy_timeout=0; BEGIN; SELECT * FROM gate",IntPtr.Zero,IntPtr.Zero,IntPtr.Zero)!=0)throw new Exception("Lease unavailable");
      if(parent.HasExited)throw new Exception("Parent exited");
      job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception();
      var limit=new EXTENDED_LIMIT(); limit.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
      int size=Marshal.SizeOf<EXTENDED_LIMIT>();memory=Marshal.AllocHGlobal(size);Marshal.StructureToPtr(limit,memory,false);
      if(!SetInformationJobObject(job,9,memory,(uint)size)) throw new Win32Exception();
      var command=new StringBuilder();for(int i=2;i<args.Length;i++){if(i>2)command.Append(' ');command.Append(Quote(args[i]));}
      IntPtr output=GetStdHandle(-11), error=GetStdHandle(-12);
      input=CreateFile("NUL",0x80000000,3,IntPtr.Zero,3,0,IntPtr.Zero);if(input==new IntPtr(-1))throw new Win32Exception();
      if(!SetHandleInformation(input,1,1))throw new Win32Exception();
      if(output!=IntPtr.Zero && output!=new IntPtr(-1)) SetHandleInformation(output,1,1);
      if(error!=IntPtr.Zero && error!=new IntPtr(-1)) SetHandleInformation(error,1,1);
      var startup=new STARTUPINFO {cb=(uint)Marshal.SizeOf<STARTUPINFO>(),dwFlags=0x100,hStdInput=input,hStdOutput=output,hStdError=error};
      if(!CreateProcess(null,command,IntPtr.Zero,IntPtr.Zero,true,CREATE_SUSPENDED|CREATE_NO_WINDOW,IntPtr.Zero,null,ref startup,out var pi))throw new Win32Exception();
      process=pi.hProcess;thread=pi.hThread;
      if(!AssignProcessToJobObject(job,process)){TerminateProcess(process,1);throw new Win32Exception();}
      IntPtr ownedJob=job; int requested=0, terminationFailed=0;
      _=Task.Run(()=>{try{parent.WaitForExit();if(!TerminateJobObject(ownedJob,1))Interlocked.Exchange(ref terminationFailed,1);}catch{if(!TerminateJobObject(ownedJob,1))Interlocked.Exchange(ref terminationFailed,1);}});
      _=Task.Run(()=>{try{var line=Console.ReadLine();if(line!=null)Interlocked.Exchange(ref requested,1);if(!TerminateJobObject(ownedJob,1))Interlocked.Exchange(ref terminationFailed,1);}catch{Interlocked.Exchange(ref terminationFailed,1);TerminateJobObject(ownedJob,1);}});
      if(ResumeThread(thread)==0xffffffff)throw new Win32Exception();
      WaitForSingleObject(process,INFINITE);GetExitCodeProcess(process,out uint exitCode);
      if(!TerminateJobObject(job,1)) Interlocked.Exchange(ref terminationFailed,1);
      // Termination is asynchronous; never report completion until every job member has exited.
      bool empty=WaitForEmptyJob(job);
      if(!empty || Volatile.Read(ref terminationFailed)!=0)return 1;
      return Volatile.Read(ref requested)!=0 ? 0 : unchecked((int)exitCode);
    } catch(Exception e) { Console.Error.WriteLine(e.GetType().Name);return 1; }
    finally {if(input!=IntPtr.Zero && input!=new IntPtr(-1))CloseHandle(input);if(memory!=IntPtr.Zero)Marshal.FreeHGlobal(memory);if(thread!=IntPtr.Zero)CloseHandle(thread);if(process!=IntPtr.Zero)CloseHandle(process);if(job!=IntPtr.Zero){TerminateJobObject(job,1);WaitForEmptyJob(job);CloseHandle(job);}if(lease!=IntPtr.Zero)sqlite3_close(lease);}
  }
}
