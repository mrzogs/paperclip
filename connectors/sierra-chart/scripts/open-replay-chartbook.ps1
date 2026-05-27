param(
  [string]$ReplayRoot = "D:\Trading\SierraChart-Replay",
  [string]$ChartbookName = "OceanTrading-PaperTrading.cht",
  [int]$WindowX = 0,
  [int]$WindowY = 0,
  [int]$WindowWidth = 1920,
  [int]$WindowHeight = 1030,
  [switch]$MoveWindow
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
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
}
"@

function Click-At([int]$x, [int]$y) {
  [SierraReplayUi]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [SierraReplayUi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [SierraReplayUi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Press-Key([byte]$virtualKey) {
  [SierraReplayUi]::keybd_event($virtualKey, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [SierraReplayUi]::keybd_event($virtualKey, 0, 0x0002, [UIntPtr]::Zero)
}

function Press-CtrlV {
  [SierraReplayUi]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [SierraReplayUi]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [SierraReplayUi]::keybd_event(0x56, 0, 0x0002, [UIntPtr]::Zero)
  [SierraReplayUi]::keybd_event(0x11, 0, 0x0002, [UIntPtr]::Zero)
}

[SierraReplayUi]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
if ($MoveWindow) {
  [SierraReplayUi]::MoveWindow($process.MainWindowHandle, $WindowX, $WindowY, $WindowWidth, $WindowHeight, $true) | Out-Null
}
[SierraReplayUi]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 750

$windowRect = New-Object SierraReplayUi+RECT
if (-not [SierraReplayUi]::GetWindowRect($process.MainWindowHandle, [ref]$windowRect)) {
  throw "Could not read replay Sierra window position."
}
$BaseX = $windowRect.Left
$BaseY = $windowRect.Top

# Coordinates are relative to the normalized replay Sierra window above.
# Coordinates are calibrated against the replay Sierra window client area.
Click-At ($BaseX + 512) ($BaseY + 60)   # Open Cbook toolbar button.
Start-Sleep -Seconds 1
Click-At ($BaseX + 785) ($BaseY + 698)  # File Name input in Open Chartbook dialog.

Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Clipboard]::SetText($ChartbookName)
Press-CtrlV
Press-Key 0x0D

Write-Output "Requested replay chartbook open: $chartbookPath"
