[CmdletBinding()]
param(
  [string]$OutputRoot = (Join-Path $env:LOCALAPPDATA 'StreamSnipe-QA'),
  [switch]$Smoke
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -notmatch 'AMD64') { throw 'This bundle requires Windows x64.' }
if (-not [IO.Path]::IsPathRooted($OutputRoot)) { throw 'OutputRoot must be an absolute path.' }
$bundle = $PSScriptRoot
$runtime = Join-Path $bundle 'app\StreamSnipe.exe'
$resources = Join-Path $bundle 'app\resources'
$engine = Join-Path $resources 'engine\dist\app.js'
$ffmpeg = Join-Path $resources 'tools\ffmpeg.exe'
$ffprobe = Join-Path $resources 'tools\ffprobe.exe'
$helper = Join-Path $resources 'tools\StreamSnipe.JobRunner.exe'
$soak = Join-Path $bundle 'soak.mjs'
$integrity = Join-Path $resources 'integrity.json'
foreach ($item in @($runtime,$engine,$ffmpeg,$ffprobe,$helper,$soak,$integrity)) {
  if (-not (Test-Path -LiteralPath $item -PathType Leaf)) { throw "Missing bundled file: $item" }
}
# Reject altered packaged resources before running synthetic recordings.
$manifest = Get-Content -Raw -LiteralPath $integrity | ConvertFrom-Json
$listed = @($manifest.files | ForEach-Object { [string]$_.path })
foreach ($required in @('dashboard/index.html','tools/yt-dlp.exe','tools/ffmpeg.exe','tools/ffprobe.exe','tools/deno.exe','tools/StreamSnipe.JobRunner.exe')) {
  if ($listed -notcontains $required) { throw "Missing integrity entry: $required" }
}
foreach ($item in $manifest.files) {
  $relative = [string]$item.path
  if ($relative -notmatch '^(tools|licenses|dashboard)/[A-Za-z0-9._/-]+$' -or ($relative -split '/') -contains '..') { throw 'Invalid integrity manifest path.' }
  $file = Join-Path $resources ($relative.Replace('/', '\'))
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing resource: $relative" }
  if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$item.sha256) { throw "Resource hash mismatch: $relative" }
}
$root = [IO.Path]::GetFullPath($OutputRoot)
$bundlePath = [IO.Path]::GetFullPath($bundle).TrimEnd('\')
if ($root.TrimEnd('\').Equals($bundlePath, [StringComparison]::OrdinalIgnoreCase) -or $root.StartsWith($bundlePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'OutputRoot must be outside the QA bundle.' }
New-Item -ItemType Directory -Force -Path $root | Out-Null
$runDir = Join-Path $root ('run-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDir -ErrorAction Stop | Out-Null
$seconds = if ($Smoke) { 30 } else { 28800 }
$stdout = Join-Path $runDir 'stdout.log'; $stderr = Join-Path $runDir 'stderr.log'
$runnerReport = Join-Path $runDir 'runner-report.json'
$report = [ordered]@{
  status='running'; smoke=[bool]$Smoke; startedAt=[DateTime]::UtcNow.ToString('o'); plannedSeconds=$seconds;
  machine=$env:COMPUTERNAME; platform=[Environment]::OSVersion.VersionString;
  runtimeSha256=(Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash.ToLowerInvariant();
  engineSha256=(Get-FileHash -LiteralPath $engine -Algorithm SHA256).Hash.ToLowerInvariant();
  ffmpegSha256=(Get-FileHash -LiteralPath $ffmpeg -Algorithm SHA256).Hash.ToLowerInvariant();
  ffprobeSha256=(Get-FileHash -LiteralPath $ffprobe -Algorithm SHA256).Hash.ToLowerInvariant();
  helperSha256=(Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash.ToLowerInvariant();
  integritySha256=(Get-FileHash -LiteralPath $integrity -Algorithm SHA256).Hash.ToLowerInvariant()
}
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runnerReport -Encoding UTF8
$previous = @{}; foreach ($name in @('ELECTRON_RUN_AS_NODE','ENGINE_MODULE_PATH','SOAK_DIRECTORY','SOAK_SECONDS','SOAK_DISTRIBUTION','FFMPEG_PATH','FFPROBE_PATH','JOB_RUNNER_PATH','NODE_PATH')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class StreamSnipePower { [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags); }'
$powerSet = $false
try {
  [Environment]::SetEnvironmentVariable('NODE_PATH',$null,'Process')
  [Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE','1','Process')
  [Environment]::SetEnvironmentVariable('ENGINE_MODULE_PATH',$engine,'Process')
  [Environment]::SetEnvironmentVariable('SOAK_DIRECTORY',$runDir,'Process')
  [Environment]::SetEnvironmentVariable('SOAK_SECONDS',[string]$seconds,'Process')
  [Environment]::SetEnvironmentVariable('SOAK_DISTRIBUTION','packaged','Process')
  [Environment]::SetEnvironmentVariable('FFMPEG_PATH',$ffmpeg,'Process')
  [Environment]::SetEnvironmentVariable('FFPROBE_PATH',$ffprobe,'Process')
  [Environment]::SetEnvironmentVariable('JOB_RUNNER_PATH',$helper,'Process')
  if ([StreamSnipePower]::SetThreadExecutionState([uint32]2147483649) -eq 0) { throw 'Could not request system-awake state.' }
  $powerSet = $true
  Write-Host "Running synthetic $seconds-second test. Reports and logs: $runDir"
  $start = [DateTime]::UtcNow
  $process = Start-Process -FilePath $runtime -ArgumentList @('"' + $soak + '"') -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  $process.WaitForExit()
  $elapsed = ([DateTime]::UtcNow - $start).TotalSeconds
  $report['exitCode'] = $process.ExitCode; $report['elapsedSeconds'] = [Math]::Round($elapsed, 1)
  if ($process.ExitCode -ne 0) { throw "Soak process failed with exit code $($process.ExitCode). See $stderr" }
  $result = Get-Content -Raw -LiteralPath (Join-Path $runDir 'report.json') | ConvertFrom-Json
  if ($result.status -ne 'passed' -or $result.plannedSeconds -ne $seconds -or $elapsed -lt ($seconds - 1)) { throw 'Soak did not meet its elapsed-time and success checks.' }
  $report['status'] = 'passed'
} catch {
  $report['status']='failed'; $report['error']=$_.Exception.Message
  throw
} finally {
  $report['finishedAt']=[DateTime]::UtcNow.ToString('o')
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $runnerReport -Encoding UTF8
  foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') }
  if ($powerSet) { [void][StreamSnipePower]::SetThreadExecutionState([uint32]2147483648) }
  Write-Host "Results: $runDir"
}
