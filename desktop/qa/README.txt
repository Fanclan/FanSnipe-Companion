StreamSnipe Windows synthetic recording QA

This private test bundle contains an unpacked candidate application and a synthetic
three-stream test. It does not install StreamSnipe or use your existing recordings.
Windows 11 x64 is required; no separate Node, FFmpeg, or .NET installation is needed.

1. Extract the entire ZIP to a new folder on an internal drive.
2. Open PowerShell in that folder and run:

   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Run-Windows-Soak.ps1

The test runs for at least eight hours of real elapsed time and requests that the
computer remain awake. Keep it plugged in. Output is written to a unique directory
under %LOCALAPPDATA%\StreamSnipe-QA, printed when the test starts and ends. The
recordings are synthetic and can consume significant disk space. The script never
removes files. To select another output root, append -OutputRoot 'D:\QA'.

For a 30-second setup check only, append -Smoke; a smoke result is not an eight-hour
soak. Send the resulting runner-report.json, report.json, stdout.log and stderr.log
to the person coordinating QA. These reports can include the computer name and local
paths; review them before sharing. If the test fails, retain the files for diagnosis.
