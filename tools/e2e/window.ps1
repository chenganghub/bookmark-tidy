# 有界面的 Chrome 测试用：截整个窗口（含工具栏和弹出的对话框），点浏览器自己的按钮（工具栏图标、授权弹窗里的按钮）。
# 只找指定进程的窗口，不碰别的窗口；不移动鼠标、不抢焦点（截图用 PrintWindow，点按钮用 UI Automation / MSAA 的默认动作）。
# 注意：Windows PowerShell 5.1 按 ANSI 读没有 BOM 的脚本，这个文件要存成带 BOM 的 UTF-8。
# 名字参数按正则匹配。
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/e2e/window.ps1 -ProcessId 1234 -Action shot -Out a.png
#   ... -Action invoke -Name '^打开书签整理$'   点第一个名字匹配的按钮，等到出现为止（最多 TimeoutMs）
#   ... -Action list                             列出这个进程的窗口里所有按钮的名字（调试用）
# 输出一行 JSON；退出码 0 成功，1 没找到或失败。
param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [ValidateSet('shot', 'invoke', 'list')][string]$Action = 'shot',
  [string]$Out = '',
  [string]$Name = '',
  [int]$TimeoutMs = 10000
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -ReferencedAssemblies Accessibility -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using Accessibility;
public static class BtWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("oleacc.dll")] static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint id, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out IAccessible acc);
  [DllImport("oleacc.dll")] static extern int AccessibleChildren(IAccessible parent, int start, int count, [Out] object[] children, out int obtained);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  /** 这个进程的可见窗口，按 EnumWindows 的顺序（Z 序从上到下） */
  public static List<IntPtr> WindowsOf(uint pid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h)) list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }

  /** MSAA：在窗口的无障碍树里找名字匹配的节点，执行它的默认动作（按钮就是「按下」）。找到返回名字，没找到返回 null */
  public static string DefaultAction(IntPtr hwnd, string pattern) {
    Guid iid = typeof(IAccessible).GUID;
    IAccessible root;
    if (AccessibleObjectFromWindow(hwnd, 0, ref iid, out root) != 0 || root == null) return null;
    return Walk(root, new Regex(pattern), 0);
  }

  static string NameOf(IAccessible acc, object child) {
    try { return acc.get_accName(child); } catch { return null; }
  }

  static string Walk(IAccessible acc, Regex re, int depth) {
    if (depth > 40) return null;
    int n = 0;
    try { n = acc.accChildCount; } catch { return null; }
    if (n <= 0) return null;
    var kids = new object[n];
    int got;
    if (AccessibleChildren(acc, 0, n, kids, out got) != 0) return null;
    for (int i = 0; i < got; i++) {
      var child = kids[i] as IAccessible;
      if (child != null) {
        string name = NameOf(child, 0);
        if (name != null && re.IsMatch(name)) {
          try { child.accDoDefaultAction(0); return name; } catch { }
        }
        string r = Walk(child, re, depth + 1);
        if (r != null) return r;
      } else if (kids[i] is int) {
        int cid = (int)kids[i];
        string name = NameOf(acc, cid);
        if (name != null && re.IsMatch(name)) {
          try { acc.accDoDefaultAction(cid); return name; } catch { }
        }
      }
    }
    return null;
  }
}
'@
# 按物理像素取窗口大小（系统缩放不是 100% 时也不裁边）
[void][BtWin]::SetProcessDPIAware()

function Out-Json($obj) { $obj | ConvertTo-Json -Compress -Depth 4 }

function Get-Rect([IntPtr]$h) {
  $r = New-Object BtWin+RECT
  [void][BtWin]::GetWindowRect($h, [ref]$r)
  return $r
}

function Get-Area($r) { return [Math]::Max(0, $r.Right - $r.Left) * [Math]::Max(0, $r.Bottom - $r.Top) }

# 主窗口：这个进程最大的可见窗口
function Get-MainWindow {
  $best = [IntPtr]::Zero
  $area = 0
  foreach ($h in [BtWin]::WindowsOf([uint32]$ProcessId)) {
    $a = Get-Area (Get-Rect $h)
    if ($a -gt $area) { $area = $a; $best = $h }
  }
  return $best
}

# 这个进程所有窗口里的按钮（含菜单项、分割按钮）
function Find-Buttons([string]$pattern) {
  $types = @([System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::MenuItem, [System.Windows.Automation.ControlType]::SplitButton)
  $conds = $types | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $_) }
  $cond = New-Object System.Windows.Automation.OrCondition($conds)
  $found = @()
  foreach ($h in [BtWin]::WindowsOf([uint32]$ProcessId)) {
    try {
      $root = [System.Windows.Automation.AutomationElement]::FromHandle($h)
      foreach ($el in $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)) {
        $n = $el.Current.Name
        if (-not $pattern -or ($n -and $n -match $pattern)) { $found += $el }
      }
    } catch {
      # 窗口刚好关了：跳过
    }
  }
  return ,$found
}

if ($Action -eq 'shot') {
  $main = Get-MainWindow
  if ($main -eq [IntPtr]::Zero) { Out-Json @{ ok = $false; error = 'no window' }; exit 1 }
  $m = Get-Rect $main
  $w = $m.Right - $m.Left
  $hgt = $m.Bottom - $m.Top
  $canvas = New-Object System.Drawing.Bitmap $w, $hgt
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  # 先画主窗口，再按 Z 序从下到上画落在它上面的其他窗口（授权对话框、菜单）
  $others = @([BtWin]::WindowsOf([uint32]$ProcessId) | Where-Object { $_ -ne $main })
  [array]::Reverse($others)
  $layers = 0
  foreach ($h in @($main) + $others) {
    $r = Get-Rect $h
    $rw = $r.Right - $r.Left
    $rh = $r.Bottom - $r.Top
    if ($rw -le 1 -or $rh -le 1) { continue }
    if ($r.Right -le $m.Left -or $r.Left -ge $m.Right -or $r.Bottom -le $m.Top -or $r.Top -ge $m.Bottom) { continue }
    $bmp = New-Object System.Drawing.Bitmap $rw, $rh
    $bg = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $bg.GetHdc()
    # 2 = PW_RENDERFULLCONTENT：窗口被挡住也能截到 Chrome 画的内容
    $ok = [BtWin]::PrintWindow($h, $hdc, 2)
    $bg.ReleaseHdc($hdc)
    $bg.Dispose()
    if ($ok) {
      $g.DrawImage($bmp, $r.Left - $m.Left, $r.Top - $m.Top, $rw, $rh)
      $layers++
    }
    $bmp.Dispose()
  }
  $g.Dispose()
  $canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
  Out-Json @{ ok = $layers -gt 0; width = $w; height = $hgt; layers = $layers; out = $Out }
  exit 0
}

if ($Action -eq 'list') {
  $names = @(Find-Buttons '' | ForEach-Object { $_.Current.Name } | Where-Object { $_ })
  Out-Json @{ ok = $true; names = $names }
  exit 0
}

# invoke：等按钮出现再点。先用 UI Automation 的 Invoke；不支持的（Chrome 的工具栏图标就是）用 MSAA 的默认动作
$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
do {
  $els = Find-Buttons $Name
  foreach ($el in $els) {
    $p = $null
    try {
      if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
        $p.Invoke()
        Out-Json @{ ok = $true; name = $el.Current.Name; how = 'uia-invoke' }
        exit 0
      }
    } catch {
      # 试下一种办法
    }
  }
  if ($els.Count -gt 0) {
    foreach ($h in [BtWin]::WindowsOf([uint32]$ProcessId)) {
      $hit = [BtWin]::DefaultAction($h, $Name)
      if ($hit) {
        Out-Json @{ ok = $true; name = $hit; how = 'msaa-default-action' }
        exit 0
      }
    }
  }
  Start-Sleep -Milliseconds 300
} while ((Get-Date) -lt $deadline)
Out-Json @{ ok = $false; error = 'not found or not clickable' }
exit 1
