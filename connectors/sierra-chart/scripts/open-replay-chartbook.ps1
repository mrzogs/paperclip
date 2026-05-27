param(
  [string]$ReplayRoot = "D:\Trading\SierraChart-Replay",
  [string]$ChartbookName = "OceanTrading-PaperTrading.cht",
  [int]$WindowX = 0,
  [int]$WindowY = 0,
  [int]$WindowWidth = 1920,
  [int]$WindowHeight = 1030
)

$ErrorActionPreference = "Stop"

if ($ReplayRoot -like "*LiveTrading*") {
  throw "Refusing to control a live Sierra Chart root: $ReplayRoot"
}

$exePath = Join-Path $ReplayRoot "SierraChart_64.exe"
if (-not (Test-Path -LiteralPath $exePath)) {
  throw "Replay Sierra executable not found: $exePath"
}

$chartbookPath = Join-Path (Join-Path $ReplayRoot "Data") $ChartbookName
if (-not (Test-Path -LiteralPath $chartbookPath)) {
  throw "Replay chartbook not found: $chartbookPath"
}

$process = Get-Process SierraChart_64 -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $exePath } |
  Select-Object -First 1

if (-not $process) {
  Start-Process -FilePath $exePath -WorkingDirectory $ReplayRoot
  Start-Sleep -Seconds 20
  $process = Get-Process SierraChart_64 -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -eq $exePath } |
    Select-Object -First 1
}

if (-not $process) {
  throw "Replay Sierra process did not start: $exePath"
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class SierraReplayUi {
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@

function Click-At([int]$x, [int]$y) {
  [SierraReplayUi]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [SierraReplayUi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [SierraReplayUi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

[SierraReplayUi]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
[SierraReplayUi]::MoveWindow($process.MainWindowHandle, $WindowX, $WindowY, $WindowWidth, $WindowHeight, $true) | Out-Null
[SierraReplayUi]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 750

# Coordinates are relative to the normalized replay Sierra window above.
# Coordinates are calibrated against the normalized replay Sierra window above.
Click-At ($WindowX + 512) ($WindowY + 60)   # Open Cbook toolbar button.
Start-Sleep -Seconds 1
Click-At ($WindowX + 785) ($WindowY + 698)  # File Name input in Open Chartbook dialog.

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait("^a")
[System.Windows.Forms.SendKeys]::SendWait($ChartbookName)
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")

Write-Output "Requested replay chartbook open: $chartbookPath"
