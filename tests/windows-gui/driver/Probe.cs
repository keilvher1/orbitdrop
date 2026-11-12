using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32;

namespace OrbitDropGui;

/// <summary>
/// `probe`: can this job drive a real desktop? Session, desktop, integrity levels,
/// screens and DPI, a screenshot, and one real Explorer drag (a file onto a folder)
/// made with synthesized input.
/// </summary>
internal static class Probe
{
    public static int Run(string outDir)
    {
        var facts = new Dictionary<string, object?>();
        Process self = Process.GetCurrentProcess();
        facts["processSessionId"] = self.SessionId;
        facts["activeConsoleSessionId"] = Native.WTSGetActiveConsoleSessionId();
        facts["userInteractive"] = Environment.UserInteractive;
        facts["processIntegrity"] = Native.IntegrityOfProcess(0);
        facts["processElevationType"] = Native.ElevationTypeOfProcess(0);
        facts["windowStation"] = Native.UserObjectName(Native.GetProcessWindowStation());
        facts["threadDesktop"] = Native.UserObjectName(Native.GetThreadDesktop(Native.GetCurrentThreadId()));
        IntPtr input = Native.OpenInputDesktop(0, false, Native.DESKTOP_READOBJECTS);
        facts["inputDesktop"] = input == IntPtr.Zero ? $"OpenInputDesktop failed ({System.Runtime.InteropServices.Marshal.GetLastWin32Error()})" : Native.UserObjectName(input);
        if (input != IntPtr.Zero) Native.CloseDesktop(input);
        facts["explorer"] = Process.GetProcessesByName("explorer").Select(p => new
        {
            pid = p.Id,
            sessionId = p.SessionId,
            integrity = Native.IntegrityOfProcess((uint)p.Id),
            elevation = Native.ElevationTypeOfProcess((uint)p.Id),
        }).ToList();
        IntPtr shell = Native.GetShellWindow();
        facts["shellWindow"] = shell == IntPtr.Zero ? null : new { cls = Native.ClassName(shell), pid = Native.WindowPid(shell) };
        facts["uac"] = ReadValues(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA", "ConsentPromptBehaviorAdmin", "PromptOnSecureDesktop", "FilterAdministratorToken");
        facts["os"] = ReadValues(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName", "DisplayVersion", "CurrentBuild", "UBR", "EditionID", "InstallationType");
        facts["virtualScreen"] = new
        {
            x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN),
            y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN),
            width = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN),
            height = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN),
            monitors = Native.GetSystemMetrics(Native.SM_CMONITORS),
        };
        facts["monitors"] = Native.Monitors().Select(m => new { bounds = m.monitor.ToString(), work = m.work.ToString(), m.dpi, m.device, m.primary }).ToList();
        facts["systemDpi"] = Native.GetDpiForSystem();
        facts["dragThreshold"] = new { cx = Native.GetSystemMetrics(Native.SM_CXDRAG), cy = Native.GetSystemMetrics(Native.SM_CYDRAG) };
        facts["swapButtons"] = Native.GetSystemMetrics(Native.SM_SWAPBUTTON) != 0;
        IntPtr fg = Native.GetForegroundWindow();
        facts["foreground"] = fg == IntPtr.Zero ? null : new { cls = Native.ClassName(fg), title = Native.WindowText(fg), pid = Native.WindowPid(fg) };
        facts["visibleTopLevel"] = Native.TopLevelWindows().Where(Native.IsWindowVisible).Take(25).Select(h =>
        {
            Native.GetWindowRect(h, out Native.RECT r);
            return $"{Native.ClassName(h)} '{Native.WindowText(h)}' {r} pid {Native.WindowPid(h)}";
        }).ToList();
        Native.POINT before = Input.Cursor();
        facts["cursorAtStart"] = before.ToString();
        Shots.Take("probe-01-desktop", "probe: desktop at start");

        // Synthesized input: does a mouse move land where asked?
        Input.MoveTo(300, 200);
        Thread.Sleep(150);
        facts["cursorAfterMoveTo300x200"] = Input.Cursor().ToString();

        // A real Explorer drag: a.txt onto the folder "target" in the same window (Explorer moves it).
        var drag = new Dictionary<string, object?>();
        facts["explorerDrag"] = drag;
        try
        {
            string root = Path.Combine(outDir, "..", "probe-work");
            string src = Path.GetFullPath(Path.Combine(root, "src"));
            Directory.CreateDirectory(Path.Combine(src, "target"));
            File.WriteAllText(Path.Combine(src, "a.txt"), "probe file\r\n");
            ExplorerWindow explorer = ExplorerWindow.Open(src, new Native.RECT { Left = 40, Top = 40, Right = 940, Bottom = 640 }, TimeSpan.FromSeconds(20));
            drag["explorerPid"] = explorer.Pid;
            drag["explorerWindowIntegrity"] = Native.IntegrityOfProcess(explorer.Pid);
            explorer.Activate();
            drag["foregroundIsExplorer"] = Native.GetForegroundWindow() == explorer.Hwnd;
            var items = explorer.Items();
            drag["items"] = items.Select(i => $"{i.name} {i.rect}").ToList();
            System.Windows.Rect? file = explorer.FindItem("a.txt", TimeSpan.FromSeconds(10));
            System.Windows.Rect? folder = explorer.FindItem("target", TimeSpan.FromSeconds(5));
            drag["fileRect"] = file?.ToString();
            drag["folderRect"] = folder?.ToString();
            if (file is System.Windows.Rect f && folder is System.Windows.Rect t)
            {
                int fx = (int)(f.Left + Math.Min(f.Width / 2, 40));
                int fy = (int)(f.Top + f.Height / 2);
                Input.Click(fx, fy);
                Thread.Sleep(500);
                drag["clickSelectedFile"] = explorer.IsSelected("a.txt");
                Shots.Take("probe-02-selected", "probe: a.txt clicked");

                Input.LeftDown();
                Thread.Sleep(150);
                Input.Glide(fx + 25, fy + 25, 250, 3);
                Input.Glide((int)(t.Left + Math.Min(t.Width / 2, 40)), (int)(t.Top + t.Height / 2), 500, 6);
                Thread.Sleep(600);
                Shots.Take("probe-03-dragging", "probe: dragging a.txt over 'target'");
                Input.LeftUp();
                string moved = Path.Combine(src, "target", "a.txt");
                var watch = Stopwatch.StartNew();
                while (watch.ElapsedMilliseconds < 5000 && !File.Exists(moved)) Thread.Sleep(200);
                drag["fileMovedIntoFolder"] = File.Exists(moved);
                drag["sourceStillThere"] = File.Exists(Path.Combine(src, "a.txt"));
                drag["moveMs"] = watch.ElapsedMilliseconds;
                Shots.Take("probe-04-after-drop", "probe: after the drop");
            }
            explorer.Close();
        }
        catch (Exception error)
        {
            drag["error"] = error.ToString();
        }
        finally
        {
            Input.ReleaseAll();
        }
        facts["failedSendInputCalls"] = Input.FailedSends;

        string json = JsonSerializer.Serialize(facts, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(Path.Combine(outDir, "probe.json"), json, new UTF8Encoding(false));
        Console.WriteLine(json);

        bool interactive = self.SessionId != 0 && facts["inputDesktop"] is string desk && desk.Equals("Default", StringComparison.OrdinalIgnoreCase);
        bool moved2 = drag.TryGetValue("fileMovedIntoFolder", out object? m) && m is true;
        var summary = new StringBuilder();
        summary.AppendLine("## Windows runner desktop probe");
        summary.AppendLine();
        summary.AppendLine("| Check | Result |");
        summary.AppendLine("|---|---|");
        summary.AppendLine($"| Session id of the job (not 0) | {self.SessionId} |");
        summary.AppendLine($"| Input desktop | {facts["inputDesktop"]} |");
        summary.AppendLine($"| Job integrity / Explorer integrity | {facts["processIntegrity"]} / {string.Join(", ", ((IEnumerable<object>)facts["explorer"]!).Select(e => e.ToString()))} |");
        summary.AppendLine($"| Monitors | {string.Join("; ", ((IEnumerable<object>)facts["monitors"]!).Select(e => e.ToString()))} |");
        summary.AppendLine($"| Click selects the file in Explorer | {(drag.TryGetValue("clickSelectedFile", out object? s) ? s : "n/a")} |");
        summary.AppendLine($"| Synthesized OLE drag moved a.txt into 'target' | {moved2} |");
        Summary.Append(summary.ToString());
        Log.Info($"probe: interactive={interactive} explorerDragWorks={moved2}");
        return interactive && moved2 ? 0 : 3;
    }

    private static Dictionary<string, object?> ReadValues(string subKey, params string[] names)
    {
        var values = new Dictionary<string, object?>();
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(subKey);
        foreach (string name in names) values[name] = key?.GetValue(name);
        return values;
    }
}

/// <summary>Appends Markdown to the GitHub job summary when running in Actions.</summary>
internal static class Summary
{
    public static void Append(string markdown)
    {
        string? path = Environment.GetEnvironmentVariable("GITHUB_STEP_SUMMARY");
        if (string.IsNullOrEmpty(path)) return;
        File.AppendAllText(path, markdown + Environment.NewLine, new UTF8Encoding(false));
    }
}
