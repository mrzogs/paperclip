param(
  [string]$ReplayRoot = "D:\Trading\SierraChart-Replay",
  [string]$StartDateTime,
  [string]$Speed = "480X",
  [switch]$ArchiveTradeActivityForStartDate,
  [int]$WindowX = 0,
  [int]$WindowY = 0,
  [int]$WindowWidth = 1920,
  [int]$WindowHeight = 1030
)

$ErrorActionPreference = "Stop"

if ($ReplayRoot -like "*LiveTrading*") {
  throw "Refusing to control a live Sierra Chart root: $ReplayRoot"
}

if (-not $StartDateTime) {
  throw "StartDateTime is required, for example: 2026-05-01 00:00:00"
}

$match = [regex]::Match($StartDateTime, "^(?<date>\d{4}-\d{2}-\d{2})[ T](?<time>\d{2}:\d{2}(?::\d{2})?)$")
if (-not $match.Success) {
  throw "StartDateTime must be in 'YYYY-MM-DD HH:MM:SS' format"
}

$allowedSpeeds = @("1X", "2X", "10X", "60X", "120X", "240X", "480X", "960X")
$normalizedSpeed = $Speed.ToUpperInvariant()
if ($allowedSpeeds -notcontains $normalizedSpeed) {
  throw "Speed must be one of: $($allowedSpeeds -join ', ')"
}

$speedNumber = $normalizedSpeed.TrimEnd("X")
if ($speedNumber -notmatch "\.") {
  $speedNumber = "$speedNumber.00"
}

if ($ArchiveTradeActivityForStartDate) {
  $tradeActivityRoot = Join-Path $ReplayRoot "TradeActivityLogs"
  if (Test-Path -LiteralPath $tradeActivityRoot) {
    $dateForFile = $match.Groups["date"].Value
    $archiveRoot = Join-Path $tradeActivityRoot ("ReplayValidationArchive_" + $dateForFile.Replace("-", "") + "_" + (Get-Date -Format "yyyyMMdd_HHmmss"))
    New-Item -ItemType Directory -Path $archiveRoot -Force | Out-Null
    Get-ChildItem -LiteralPath $tradeActivityRoot -File -Filter "TradeActivityLog_${dateForFile}_UTC*.data" |
      ForEach-Object {
        Move-Item -LiteralPath $_.FullName -Destination (Join-Path $archiveRoot $_.Name)
      }
    Write-Output "Archived replay trade activity files for ${dateForFile}: $archiveRoot"
  }
}

$exePath = Join-Path $ReplayRoot "SierraChart_64.exe"
$process = Get-Process SierraChart_64 -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -eq $exePath } |
  Select-Object -First 1

if (-not $process) {
  throw "Replay Sierra process is not running: $exePath"
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class SierraReplayWindowUi {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hWnd, EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr hWnd, string lpString);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hWnd, int Msg, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, int Msg, IntPtr wParam, IntPtr lParam);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@

function Click-At([int]$x, [int]$y) {
  [SierraReplayWindowUi]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [SierraReplayWindowUi]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [SierraReplayWindowUi]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Type-Into([int]$x, [int]$y, [string]$text) {
  Click-At $x $y
  Start-Sleep -Milliseconds 150
  [System.Windows.Forms.SendKeys]::SendWait("^a")
  Start-Sleep -Milliseconds 100
  [System.Windows.Forms.SendKeys]::SendWait($text)
  Start-Sleep -Milliseconds 150
}

function Get-WindowTextValue([IntPtr]$hWnd) {
  $text = New-Object System.Text.StringBuilder 512
  [SierraReplayWindowUi]::GetWindowText($hWnd, $text, 512) | Out-Null
  $text.ToString()
}

function Get-ClassNameValue([IntPtr]$hWnd) {
  $class = New-Object System.Text.StringBuilder 256
  [SierraReplayWindowUi]::GetClassName($hWnd, $class, 256) | Out-Null
  $class.ToString()
}

function Get-WindowRectValue([IntPtr]$hWnd) {
  $rect = New-Object SierraReplayWindowUi+RECT
  [SierraReplayWindowUi]::GetWindowRect($hWnd, [ref]$rect) | Out-Null
  [pscustomobject]@{
    Left = $rect.Left
    Top = $rect.Top
    Right = $rect.Right
    Bottom = $rect.Bottom
    Width = $rect.Right - $rect.Left
    Height = $rect.Bottom - $rect.Top
  }
}

function Find-ReplayDialog {
  $replayDialogs = New-Object System.Collections.ArrayList
  $callback = [SierraReplayWindowUi+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [SierraReplayWindowUi]::IsWindowVisible($hWnd)) { return $true }
    $title = Get-WindowTextValue $hWnd
    $class = Get-ClassNameValue $hWnd
    if ($class -eq "#32770" -and ($title -match "Replay Chart" -or ($title -match "MNQM26_FUT_CME" -and $title -match "Replay|5 Min"))) {
      [void]$replayDialogs.Add([object]$hWnd)
    }
    return $true
  }
  [SierraReplayWindowUi]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  if ($replayDialogs.Count -gt 0) { return [IntPtr]$replayDialogs[0] }
  return [IntPtr]::Zero
}

function Get-ChildControls([IntPtr]$dialog) {
  $controls = New-Object System.Collections.ArrayList
  $callback = [SierraReplayWindowUi+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    $rect = Get-WindowRectValue $hWnd
    [void]$controls.Add([object][pscustomobject]@{
      Hwnd = $hWnd
      Class = Get-ClassNameValue $hWnd
      Text = Get-WindowTextValue $hWnd
      X = $rect.Left
      Y = $rect.Top
      W = $rect.Width
      H = $rect.Height
    })
    return $true
  }
  [SierraReplayWindowUi]::EnumChildWindows($dialog, $callback, [IntPtr]::Zero) | Out-Null
  $controls
}

function Click-Control([IntPtr]$hWnd) {
  [SierraReplayWindowUi]::PostMessage($hWnd, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
}

function Find-VisibleDialogs {
  $dialogs = New-Object System.Collections.ArrayList
  $callback = [SierraReplayWindowUi+EnumWindowsProc]{
    param([IntPtr]$hWnd, [IntPtr]$lParam)
    if (-not [SierraReplayWindowUi]::IsWindowVisible($hWnd)) { return $true }
    $class = Get-ClassNameValue $hWnd
    if ($class -eq "#32770") {
      [void]$dialogs.Add([object][pscustomobject]@{
        Hwnd = $hWnd
        Text = Get-WindowTextValue $hWnd
        Rect = Get-WindowRectValue $hWnd
      })
    }
    return $true
  }
  [SierraReplayWindowUi]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  $dialogs
}

function Click-DialogButtonByText([IntPtr]$dialog, [string[]]$texts) {
  $controls = Get-ChildControls $dialog
  foreach ($text in $texts) {
    $button = $controls | Where-Object { $_.Class -eq "Button" -and $_.Text -eq $text } | Select-Object -First 1
    if ($button) {
      Click-Control $button.Hwnd
      Start-Sleep -Milliseconds 200
      # Some Sierra modal prompts, notably "Enter Processing Step in Seconds",
      # do not always respond to BM_CLICK. Follow with a physical click on the
      # same button center so replay automation matches operator behavior.
      Click-At ($button.X + [int]($button.W / 2)) ($button.Y + [int]($button.H / 2))
      return $true
    }
  }
  return $false
}

function Accept-ReplayPrompts([IntPtr]$replayDialog) {
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    $handled = $false
    $dialogs = Find-VisibleDialogs
    foreach ($dialogInfo in $dialogs) {
      if ($dialogInfo.Hwnd -eq $replayDialog) { continue }
      $text = $dialogInfo.Text
      if ($text -match "Sierra|Replay|Chart|Confirm|Notice|Message|Trade|Processing|Step|Seconds|Clear Trade Data|Enter Processing Step") {
        [SierraReplayWindowUi]::SetForegroundWindow($dialogInfo.Hwnd) | Out-Null
        Start-Sleep -Milliseconds 150
        if (Click-DialogButtonByText $dialogInfo.Hwnd @("Yes", "OK", "Continue")) {
          Write-Output "Accepted Sierra replay prompt: $text"
          $handled = $true
          Start-Sleep -Milliseconds 750
          break
        }
      }
    }
    if (-not $handled) {
      Start-Sleep -Milliseconds 250
    }
  }
}

function Force-Chart-Recalculate {
  $ws = New-Object -ComObject WScript.Shell
  [SierraReplayWindowUi]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 200
  $ws.SendKeys("{INSERT}")
  Start-Sleep -Milliseconds 750
}

function Close-ReplayDialog([IntPtr]$dialogToClose) {
  if ($dialogToClose -eq [IntPtr]::Zero) {
    return
  }
  $rect = Get-WindowRectValue $dialogToClose
  [SierraReplayWindowUi]::SetForegroundWindow($dialogToClose) | Out-Null
  Start-Sleep -Milliseconds 150
  Click-At ($rect.Right - 16) ($rect.Top + 14)
  Start-Sleep -Milliseconds 750
}

function Resume-IfPaused {
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    $title = Get-WindowTextValue $process.MainWindowHandle
    if ($title -notmatch "Paused") {
      return
    }
    [SierraReplayWindowUi]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 200
    Click-At ($WindowX + 1475) ($WindowY + 69)
    Start-Sleep -Seconds 2
  }
  $title = Get-WindowTextValue $process.MainWindowHandle
  if ($title -match "Paused") {
    throw "Replay remained paused after clicking the Replay Pause toolbar button."
  }
}

Add-Type -AssemblyName System.Windows.Forms

[SierraReplayWindowUi]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
[SierraReplayWindowUi]::MoveWindow($process.MainWindowHandle, $WindowX, $WindowY, $WindowWidth, $WindowHeight, $true) | Out-Null
[SierraReplayWindowUi]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 750

$existingDialog = Find-ReplayDialog
Close-ReplayDialog $existingDialog

# Coordinates are calibrated against the normalized replay Sierra window above.
Click-At ($WindowX + 1507) ($WindowY + 70)  # Replay Chart toolbar button.
Start-Sleep -Milliseconds 750

$dateText = $match.Groups["date"].Value.Replace("-", "/")
$timeText = $match.Groups["time"].Value
if ($timeText.Length -eq 5) {
  $timeText = "$timeText`:00"
}

$dialog = Find-ReplayDialog
if ($dialog -eq [IntPtr]::Zero) {
  throw "Replay Chart dialog not found after clicking Replay Chart."
}

$controls = Get-ChildControls $dialog
$pauseButton = $controls | Where-Object { $_.Class -eq "Button" -and $_.Text -eq "Pause" } | Select-Object -First 1
if ($pauseButton) {
  $stopButton = $controls | Where-Object { $_.Class -eq "Button" -and $_.Text -eq "Stop" } | Select-Object -First 1
  if ($stopButton) {
    Click-Control $stopButton.Hwnd
    Start-Sleep -Seconds 8
    $controls = Get-ChildControls $dialog
  }
}

$dialogRect = Get-WindowRectValue $dialog
$useStartDateTime = $controls | Where-Object { $_.Class -eq "Button" -and $_.Text -eq "Use Start Date-Time" } | Select-Object -First 1
if ($useStartDateTime) {
  $checked = [SierraReplayWindowUi]::SendMessage($useStartDateTime.Hwnd, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
  if ($checked -eq 0) {
    Click-At ($useStartDateTime.X + 8) ($useStartDateTime.Y + [int]($useStartDateTime.H / 2))
    Start-Sleep -Milliseconds 350
  }
  [SierraReplayWindowUi]::SendMessage($useStartDateTime.Hwnd, 0x00F1, [IntPtr]1, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Milliseconds 250
  $controls = Get-ChildControls $dialog
}

$edits = $controls | Where-Object { $_.Class -eq "Edit" } | Sort-Object Y, X
$dateEdit = $edits | Select-Object -First 1
$timeEdit = $edits | Select-Object -Skip 1 -First 1
$speedEdit = $edits | Select-Object -Skip 2 -First 1

if (-not $dateEdit -or -not $timeEdit -or -not $speedEdit) {
  Type-Into ($WindowX + 556) ($WindowY + 322) $dateText
  Type-Into ($WindowX + 690) ($WindowY + 322) $timeText
  Type-Into ($WindowX + 575) ($WindowY + 368) $speedNumber
} else {
  [SierraReplayWindowUi]::SetWindowText($dateEdit.Hwnd, $dateText) | Out-Null
  [SierraReplayWindowUi]::SetWindowText($timeEdit.Hwnd, $timeText) | Out-Null
  [SierraReplayWindowUi]::SetWindowText($speedEdit.Hwnd, $speedNumber) | Out-Null
  [SierraReplayWindowUi]::SendMessage($dateEdit.Hwnd, 0x000C, [IntPtr]::Zero, $dateText) | Out-Null
  [SierraReplayWindowUi]::SendMessage($timeEdit.Hwnd, 0x000C, [IntPtr]::Zero, $timeText) | Out-Null
  [SierraReplayWindowUi]::SendMessage($speedEdit.Hwnd, 0x000C, [IntPtr]::Zero, $speedNumber) | Out-Null
  Start-Sleep -Milliseconds 250
  $dateReadback = Get-WindowTextValue $dateEdit.Hwnd
  $timeReadback = Get-WindowTextValue $timeEdit.Hwnd
  $speedReadback = Get-WindowTextValue $speedEdit.Hwnd
  Write-Output "Replay dialog readback before Play: date=$dateReadback time=$timeReadback speed=$speedReadback"
  if ($dateReadback -ne $dateText -or $timeReadback -ne $timeText -or $speedReadback -ne $speedNumber) {
    throw "Replay dialog field readback failed before Play. Expected date=$dateText time=$timeText speed=$speedNumber; got date=$dateReadback time=$timeReadback speed=$speedReadback"
  }
}

# Sierra persists this checkbox and a checked value leaves the replay paused
# after Play. For unattended validation we force the current saved replay
# chartbook state to run immediately.
$controls = Get-ChildControls $dialog
$startPaused = $controls | Where-Object { $_.Class -eq "Button" -and $_.Text -eq "Start Paused" } | Select-Object -First 1
if ($startPaused) {
  $checked = [SierraReplayWindowUi]::SendMessage($startPaused.Hwnd, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
  if ($checked -ne 0) {
    # Sierra's replay dialog does not always honor BM_SETCHECK here. Use the
    # same physical checkbox path an operator would use and verify the state.
    Click-At ($startPaused.X + 8) ($startPaused.Y + [int]($startPaused.H / 2))
    Start-Sleep -Milliseconds 150
    $checked = [SierraReplayWindowUi]::SendMessage($startPaused.Hwnd, 0x00F0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    if ($checked -ne 0) {
      throw "Replay dialog Start Paused checkbox remained checked after click; refusing to start an unattended replay."
    }
  }
}
Start-Sleep -Milliseconds 250
$controls = Get-ChildControls $dialog
$edits = $controls | Where-Object { $_.Class -eq "Edit" } | Sort-Object Y, X
$dateEdit = $edits | Select-Object -First 1
$timeEdit = $edits | Select-Object -Skip 1 -First 1
$speedEdit = $edits | Select-Object -Skip 2 -First 1
if ($dateEdit -and $timeEdit -and $speedEdit) {
  $dateReadback = Get-WindowTextValue $dateEdit.Hwnd
  $timeReadback = Get-WindowTextValue $timeEdit.Hwnd
  $speedReadback = Get-WindowTextValue $speedEdit.Hwnd
  Write-Output "Replay dialog final readback before Play: date=$dateReadback time=$timeReadback speed=$speedReadback"
  if ($dateReadback -ne $dateText -or $timeReadback -ne $timeText -or $speedReadback -ne $speedNumber) {
    throw "Replay dialog field changed before Play. Expected date=$dateText time=$timeText speed=$speedNumber; got date=$dateReadback time=$timeReadback speed=$speedReadback"
  }
}
$playButton = $controls | Where-Object { $_.Class -eq "Button" -and $_.Text -eq "Play" } | Select-Object -First 1
if ($playButton) {
  Click-Control $playButton.Hwnd
} else {
  Click-At ($WindowX + 719) ($WindowY + 365)  # Play fallback.
}
Start-Sleep -Milliseconds 750
Accept-ReplayPrompts $dialog
Start-Sleep -Milliseconds 750
Accept-ReplayPrompts $dialog

Close-ReplayDialog $dialog
$currentDialog = Find-ReplayDialog
Close-ReplayDialog $currentDialog
Resume-IfPaused

Write-Output "Requested replay window start via Sierra UI: $StartDateTime at $normalizedSpeed"
