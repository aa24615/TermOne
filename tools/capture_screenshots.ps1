#!/usr/bin/env pwsh
# Capture TermOne screenshots for the project docs.
#
#   powershell -ExecutionPolicy Bypass -File tools/capture_screenshots.ps1 [-Probe]
#
# Pure managed APIs only (UI Automation + System.Drawing + AppActivate).
# The app is driven by UIA InvokePattern; no P/Invoke, no C# compilation.

param(
    [string]$Exe = "D:\www\nas-claw\sshz\target\x86_64-pc-windows-gnu\release\termone.exe",
    [string]$Out = "D:\www\nas-claw\sshz\docs\screenshots",
    [switch]$Probe,
    [switch]$Walk
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName Microsoft.VisualBasic

$ae = [System.Windows.Automation.AutomationElement]
$prop = [System.Windows.Automation.AutomationElement]

function Start-App {
    Write-Host "starting: $Exe"
    try { return Start-Process -FilePath $Exe -PassThru } catch { Write-Host "Start-Process blocked: $($_.Exception.Message)" }
    try { return [System.Diagnostics.Process]::Start($Exe) } catch { Write-Host "Process.Start failed: $($_.Exception.Message)" }
    throw "could not start $Exe"
}

function Get-App {
    $p = Get-Process -Name termone -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
        Select-Object -First 1
    if ($p) { return $p }
    $p = Start-App
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        $p.Refresh()
        if ($p.MainWindowHandle -ne [IntPtr]::Zero) { break }
    }
    Start-Sleep -Seconds 2
    $p.Refresh()
    return $p
}

function Focus-App([System.Diagnostics.Process]$p) {
    [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) | Out-Null
    Start-Sleep -Milliseconds 700
}

function Save-Window([System.Diagnostics.Process]$p, [string]$path) {
    Focus-App $p
    $root = $ae::FromHandle($p.MainWindowHandle)
    $r = $root.Current.BoundingRectangle
    $w = [int][Math]::Round($r.Width)
    $h = [int][Math]::Round($r.Height)
    $x = [int][Math]::Round($r.X)
    $y = [int][Math]::Round($r.Y)
    # trim bottom edge (window shadow / taskbar bleed)
    $h = [Math]::Max(100, $h - 48)
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
    $g.Dispose()
    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "saved: $path ($w x $h)"
}

function Wait-Ready([System.Diagnostics.Process]$p) {
    for ($i = 0; $i -lt 30; $i++) {
        Focus-App $p
        $root = $ae::FromHandle($p.MainWindowHandle)
        $n = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition).Count
        if ($n -ge 20) { Write-Host "UIA ready ($n elements)"; return }
        Start-Sleep -Milliseconds 1000
    }
    Write-Host "warn: UIA tree still small"
}

function Click-Text([System.Diagnostics.Process]$p, [string]$text, [string]$class = "") {
    # retry: the WebView2 UIA tree can take a moment to populate
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        Focus-App $p
        $root = $ae::FromHandle($p.MainWindowHandle)
    $el = $null
    if ($class) {
        $both = New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition($prop::NameProperty, $text)),
            (New-Object System.Windows.Automation.PropertyCondition($prop::ClassNameProperty, $class)))
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $both)
    } else {
        $cond = New-Object System.Windows.Automation.PropertyCondition($prop::NameProperty, $text)
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    }
    if (-not $el) {
        Start-Sleep -Milliseconds 1500
        continue
    }
    $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    ([System.Windows.Automation.InvokePattern]$pat).Invoke()
    Write-Host "clicked: $text"
    Start-Sleep -Milliseconds 900
    return
    }
    $names = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition($prop::ControlTypeProperty,
            [System.Windows.Automation.ControlType]::Button))) |
        ForEach-Object { $_.Current.Name })
    throw "UIA element not found: '$text' (class '$class'). buttons: " + ($names -join " | ")
}

function Close-All-Tabs([System.Diagnostics.Process]$p) {
    for ($i = 0; $i -lt 6; $i++) {
        Focus-App $p
        $root = $ae::FromHandle($p.MainWindowHandle)
        $cond = New-Object System.Windows.Automation.AndCondition(
            (New-Object System.Windows.Automation.PropertyCondition($prop::NameProperty, "关闭")),
            (New-Object System.Windows.Automation.PropertyCondition($prop::ClassNameProperty, "tab-close")))
        $el = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
        if (-not $el) { Write-Host "no more tabs"; return }
        ([System.Windows.Automation.InvokePattern]$el.GetCurrentPattern(
            [System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
        Write-Host "closed a tab"
        Start-Sleep -Milliseconds 900
    }
}

function Type-Line([System.Diagnostics.Process]$p, [string]$text) {
    Focus-App $p
    [System.Windows.Forms.SendKeys]::SendWait($text)
    Start-Sleep -Milliseconds 900
}

$p = Get-App
if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { throw "TermOne window not available" }
Write-Host "pid $($p.Id), hwnd $($p.MainWindowHandle), title '$($p.MainWindowTitle)'"

if ($Walk) {
    Focus-App $p
    $root = $ae::FromHandle($p.MainWindowHandle)
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $node = $walker.GetFirstChild($root)
    $depth = 0
    $count = 0
    while ($node -and $count -lt 60) {
        $count++
        "{0}{1} :: {2}" -f ("  " * $depth), $node.Current.ControlType.ProgrammaticName, $node.Current.Name
        $child = $walker.GetFirstChild($node)
        if ($child) { $node = $child; $depth++ }
        else {
            while ($node -and -not ($walker.GetNextSibling($node))) { $node = $walker.GetParent($node); $depth-- }
            if ($node) { $node = $walker.GetNextSibling($node) }
        }
    }
    return
}

if ($Probe) {
    $root = $ae::FromHandle($p.MainWindowHandle)
    $root.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition) |
        Where-Object { $_.Current.Name -ne "" } |
        Select-Object -First 60 -ExpandProperty Current |
        Select-Object ControlType, Name | Format-Table -AutoSize
    return
}

if (-not (Test-Path $Out)) { New-Item -ItemType Directory -Path $Out -Force | Out-Null }
Wait-Ready $p
# maximize so no other window overlaps the capture area
Click-Text $p "最大化"
Start-Sleep -Seconds 1

# 0. close open tabs so the welcome pane shows again
Close-All-Tabs $p
Start-Sleep -Seconds 1

# 1. Welcome pane
Save-Window $p (Join-Path $Out "welcome.png")

# 2. New profile dialog (use the always-visible sidebar "+" button)
Click-Text $p "新建档案"
Save-Window $p (Join-Path $Out "profile-new.png")
Click-Text $p "取消"

# 3. Local terminal with a couple of commands (default shell on Windows is PowerShell)
Click-Text $p "新建本地终端 (Ctrl+T)"
Start-Sleep -Seconds 3
Type-Line $p "echo TermOne - lightweight terminal{ENTER}"
Type-Line $p "Get-Date{ENTER}"
Type-Line $p "Get-Location{ENTER}"
Start-Sleep -Seconds 1
Save-Window $p (Join-Path $Out "terminal-local.png")

# 4. Settings dialog
Click-Text $p "设置"
Save-Window $p (Join-Path $Out "settings.png")
Click-Text $p "关闭" "icon-btn"

# restore window size
Click-Text $p "还原"

Write-Host "done"
