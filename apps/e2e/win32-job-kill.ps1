# Windows only. Helper for win32-job-kill.mjs. Do not run it alone.
#
# -Mode probe: make a Job Object with -Limits, start the parent node in it, let the parent start a
#   child, wait for the parent to exit, close the job handle, then print one word for the child:
#   survived | killed | spawn-failed:<detail>. With -StatusPort, survived also needs an answer
#   on http://127.0.0.1:<port>/status, else survived-no-status.
# -Mode breakaway-spawn: start -Cmd with CREATE_BREAKAWAY_FROM_JOB | DETACHED_PROCESS |
#   CREATE_NEW_PROCESS_GROUP. Print the pid, or "error:<win32 code>".
# -Mode ambient: print the limit flags of the job that holds this process, or "none".
param(
  [Parameter(Mandatory = $true)][string]$Mode,
  [string]$Limits = '0',
  [string]$Arm = '',
  [string]$Node = '',
  [string]$Script = '',
  [string]$Dir = '',
  [string]$Cmd = '',
  [string]$StatusPort = ''
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class JobProbe {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimit {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct StartupInfo {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ProcessInfo { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref ExtendedLimit info, int len);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int cls, out ExtendedLimit info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, System.Text.StringBuilder cmd, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfo si, out ProcessInfo pi);

  const int ExtendedLimitInformation = 9;

  public static IntPtr NewJob(uint flags) {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error()); }
    ExtendedLimit info = new ExtendedLimit();
    info.Basic.LimitFlags = flags;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref info, Marshal.SizeOf(info))) {
      throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    }
    return job;
  }

  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) {
      throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error());
    }
  }

  // The flags of the job that holds this process (null handle = own job), or "none".
  public static string Ambient() {
    bool inJob;
    IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out inJob);
    if (!inJob) { return "none"; }
    ExtendedLimit info;
    if (!QueryInformationJobObject(IntPtr.Zero, ExtendedLimitInformation, out info, Marshal.SizeOf(typeof(ExtendedLimit)), IntPtr.Zero)) {
      return "in-job, query error " + Marshal.GetLastWin32Error();
    }
    return "0x" + info.Basic.LimitFlags.ToString("X");
  }

  public static string SpawnBreakaway(string cmd) {
    StartupInfo si = new StartupInfo();
    si.cb = Marshal.SizeOf(si);
    ProcessInfo pi;
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB
    uint flags = 0x8 | 0x200 | 0x01000000;
    if (!CreateProcess(null, new System.Text.StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null, ref si, out pi)) {
      return "error:" + Marshal.GetLastWin32Error();
    }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return pi.dwProcessId.ToString();
  }
}
'@

function Test-Alive([int]$ProcessId) {
  return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

if ($Mode -eq 'ambient') {
  Write-Output ([JobProbe]::Ambient())
  exit 0
}

if ($Mode -eq 'breakaway-spawn') {
  Write-Output ([JobProbe]::SpawnBreakaway($Cmd))
  exit 0
}

if ($Mode -ne 'probe') {
  throw "unknown -Mode $Mode"
}

$pidFile = Join-Path $Dir "$Arm.pid"
$goFile = Join-Path $Dir "$Arm.go"
$job = [JobProbe]::NewJob([Convert]::ToUInt32($Limits, 16))
# The parent waits for the go file, so it cannot start the child before it is in the job.
$parent = Start-Process -FilePath $Node -ArgumentList @("`"$Script`"", '--parent', $Arm, "`"$Dir`"") -PassThru -NoNewWindow
[JobProbe]::Assign($job, $parent.Handle)
Set-Content -Path $goFile -Value 'go'

if (-not $parent.WaitForExit(60000)) {
  Write-Output 'spawn-failed:parent-timeout'
  exit 0
}
$recorded = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { 'missing' }
if ($recorded -notmatch '^\d+$') {
  [JobProbe]::CloseHandle($job) | Out-Null
  Write-Output "spawn-failed:$recorded"
  exit 0
}
$childPid = [int]$recorded
if (-not (Test-Alive $childPid)) {
  [JobProbe]::CloseHandle($job) | Out-Null
  Write-Output 'spawn-failed:child-dead-before-close'
  exit 0
}

# This process holds the only handle, so this close is what fires KILL_ON_JOB_CLOSE.
[JobProbe]::CloseHandle($job) | Out-Null
Start-Sleep -Milliseconds 2000
if (Test-Alive $childPid) {
  $outcome = 'survived'
  if ($StatusPort -ne '') {
    $outcome = 'survived-no-status'
    # The daemon can still be binding. Wait up to 30 s for its first answer.
    for ($i = 0; $i -lt 60; $i++) {
      try {
        Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri "http://127.0.0.1:$StatusPort/status" | Out-Null
        $outcome = 'survived'
        break
      } catch {
        Start-Sleep -Milliseconds 500
      }
    }
  }
  Write-Output $outcome
  Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
} else {
  Write-Output 'killed'
}
