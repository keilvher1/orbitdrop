using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using Microsoft.Win32;

namespace OrbitDropGui;

internal sealed record Check(string What, bool Ok, string Detail);

internal sealed class CaseResult
{
    public string Id { get; init; } = "";
    public string Title { get; init; } = "";
    public int Index { get; init; }
    public List<Check> Checks { get; } = new();
    public List<string> Screenshots { get; } = new();
    public string? Error { get; set; }
    public double Seconds { get; set; }
    public bool Passed => Error == null && Checks.Count > 0 && Checks.All(c => c.Ok);

    public bool Add(string what, bool ok, string detail = "")
    {
        Checks.Add(new Check(what, ok, detail));
        Log.Info($"  [{(ok ? "ok" : "FAIL")}] {what}{(detail.Length > 0 ? " - " + detail : "")}");
        return ok;
    }

    public void Shot(string name, string note)
    {
        string? path = Shots.Take($"{Index:00}-{name}", note);
        if (path != null) Screenshots.Add(Path.GetFileName(path));
    }
}

/// <summary>
/// `suite`: the drag cases against the running, packaged OrbitDrop. Every case drags a real file out
/// of a real File Explorer window with synthesized input (mouse down, move past SM_CXDRAG, Shift),
/// waits for the helper's wheel window, aims at a sector computed from the shared geometry, and
/// checks the files on disk, the wheel's own text (its window title) and OrbitDrop's log.
/// </summary>
internal static class Suite
{
    private sealed class Context
    {
        public SharedGeometry G { get; init; } = null!;
        public MainLog AppLog { get; init; } = null!;
        public ExplorerWindow Explorer { get; set; } = null!;
        public string Folder { get; init; } = "";
        public Native.POINT Activation { get; set; }
        public Native.RECT Work { get; set; }
        public Dictionary<string, string> Hashes { get; } = new(StringComparer.OrdinalIgnoreCase);
        public string OutDir { get; init; } = "";
        public string Fixtures { get; init; } = "";
        public string ReadyLine { get; set; } = "";
        public Process? App { get; init; }
    }

    /// <summary>Waits for a main.log line; gives up early when the app process has exited.</summary>
    private static string? WaitForLine(MainLog log, string needle, Process? app, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        while (true)
        {
            string? line = log.Lines().FirstOrDefault(l => l.Contains(needle, StringComparison.Ordinal));
            if (line != null) return line;
            if (app is { HasExited: true } || watch.Elapsed >= timeout) return null;
            Thread.Sleep(250);
        }
    }

    private const string PdfFixture = "Page 001.pdf";
    private const string JpgFixture = "photo.jpg";

    /// <summary>Source file of each case (copies of the two repository fixtures).</summary>
    private static readonly (string name, string fixture)[] CaseFiles =
    {
        (PdfFixture, PdfFixture),
        (JpgFixture, JpgFixture),
        ("escape.pdf", PdfFixture),
        ("outside.pdf", PdfFixture),
        ("deadzone.pdf", PdfFixture),
        ("shift-up.pdf", PdfFixture),
        ("rapid-a.pdf", PdfFixture),
        ("rapid-b.pdf", PdfFixture),
    };

    public static int Run(string outDir, Dictionary<string, string?> options)
    {
        string work = Required(options, "work");
        string fixtures = Required(options, "fixtures");
        var g = SharedGeometry.Load(Required(options, "geometry"));
        var appLog = new MainLog(Required(options, "main-log"));
        var environment = new Dictionary<string, object?>();
        var results = new List<CaseResult>();

        // ------------------------------------------------------------ start OrbitDrop and wait until it is ready
        // The driver starts the installed app itself, so the app lives exactly as long as the cases run
        // (a process started by an earlier workflow step may not survive that step) and its exit is seen.
        Process? app = null;
        string? launch = options.GetValueOrDefault("launch");
        if (launch != null)
        {
            app = AppProcess.Start(launch, Path.Combine(outDir, "app-stdio"));
            environment["app"] = $"{launch} pid {app.Id}";
        }
        Log.Info($"waiting for OrbitDrop: {appLog.FilePath}");
        var startWatch = Stopwatch.StartNew();
        string? ready = WaitForLine(appLog, "native helper ready", app, TimeSpan.FromSeconds(240));
        string? capabilities = WaitForLine(appLog, "capabilities ready", app, TimeSpan.FromSeconds(240) - startWatch.Elapsed);
        environment["helperReady"] = ready;
        environment["capabilities"] = capabilities;
        environment["readyAfter"] = $"{startWatch.Elapsed.TotalSeconds:F1} s";
        if (ready == null || capabilities == null)
        {
            string exited = app is { HasExited: true } ? $"; OrbitDrop exited with code {app.ExitCode} (0x{app.ExitCode:X8}) at {app.ExitTime:HH:mm:ss.fff}" : "";
            Log.Info($"OrbitDrop did not report 'native helper ready' and 'capabilities ready'{exited}");
            WriteResults(outDir, environment, results, fatal: $"OrbitDrop did not start (no 'native helper ready' / 'capabilities ready' in main.log){exited}");
            return 3;
        }
        if (MainLog.Field(ready, "globalDrag") != "true")
        {
            WriteResults(outDir, environment, results, fatal: $"the helper reports global drag unavailable: {MainLog.Field(ready, "reason")}");
            return 3;
        }
        Thread.Sleep(1500); // configure follows `capabilities ready` within milliseconds; leave room for it
        environment["os"] = OsText();
        Native.RECT work0 = Native.MonitorAt(0, 0).work;
        var monitor = Native.MonitorAt(0, 0);
        environment["screen"] = $"{monitor.monitor.Width}x{monitor.monitor.Height} px, work area {monitor.work}, {monitor.dpi} dpi ({monitor.dpi * 100 / 96} %), monitors {Native.GetSystemMetrics(Native.SM_CMONITORS)}";
        environment["processes"] = ProcessFacts();

        // ------------------------------------------------------------ test folder and Explorer
        string folder = Path.Combine(work, "OrbitDrop GUI test");
        if (Directory.Exists(folder)) Directory.Delete(folder, recursive: true);
        Directory.CreateDirectory(folder);
        var ctx = new Context { G = g, AppLog = appLog, Folder = folder, OutDir = outDir, Fixtures = fixtures, Work = work0, App = app };
        foreach ((string name, string fixture) in CaseFiles)
        {
            string target = Path.Combine(folder, name);
            File.Copy(Path.Combine(fixtures, fixture), target);
            ctx.Hashes[name] = Sha256(target);
        }
        ShowFileExtensions();
        ctx.Explorer = ExplorerWindow.Open(folder, work0, TimeSpan.FromSeconds(20));
        ctx.Explorer.Activate();
        environment["explorer"] = $"pid {ctx.Explorer.Pid}, integrity {Native.IntegrityOfProcess(ctx.Explorer.Pid)}, window {ctx.Explorer.Rect}";
        // Where each wheel opens: inside the items view, away from the screen edges and from the
        // notification toasts (bottom right), so the caption strip fits below the disc.
        ctx.Activation = new Native.POINT(work0.Left + (int)(work0.Width * 0.58), work0.Top + (int)(work0.Height * 0.58));
        environment["activationPoint"] = ctx.Activation.ToString();
        Shots.Take("00-explorer", "Explorer on the test folder (before the cases)");

        ctx.ReadyLine = ready;
        RunCase(results, ctx, "startup", "Fresh start of the installed app: no window, helper ready, global drag available", Startup);
        RunCase(results, ctx, "pdf-to-jpg", "PDF → JPG: Explorer drag, Shift, drop on JPG (Shift held through the drop)", PdfToJpg);
        RunCase(results, ctx, "jpg-to-png", "JPG → PNG: 8-sector image menu, drop on PNG (top)", JpgToPng);
        RunCase(results, ctx, "escape", "Esc during the drag cancels: wheel gone, no output", Escape);
        RunCase(results, ctx, "outside-ring", "Drop outside the ring (wheel window's transparent corner): no output, source not moved", OutsideRing);
        RunCase(results, ctx, "dead-zone", "Release on the centre (dead zone): refused, no output", DeadZone);
        RunCase(results, ctx, "shift-released", "Shift released before the drop: the wheel stays, the drop still converts", ShiftReleased);
        RunCase(results, ctx, "text-drag", "Plain-text drag (not a file): 'not a file' wheel, refused", TextDrag);
        RunCase(results, ctx, "rapid-drops", "Two quick drops in a row: exactly one result each", RapidDrops);

        Shots.Take("99-final-explorer", "Explorer after all cases");
        environment["filesAtEnd"] = Directory.GetFiles(folder).Select(f => Path.GetFileName(f)).OrderBy(n => n, StringComparer.Ordinal).ToList();
        environment["failedSendInputCalls"] = Input.FailedSends;
        try
        {
            ctx.Explorer.Close();
        }
        catch
        {
            // best effort
        }
        WriteResults(outDir, environment, results, fatal: null);
        return results.All(r => r.Passed) ? 0 : 3;
    }

    private static string Required(Dictionary<string, string?> options, string key) =>
        options.GetValueOrDefault(key) ?? throw new ArgumentException($"--{key} is required");

    private static void RunCase(List<CaseResult> results, Context ctx, string id, string title, Action<Context, CaseResult> body)
    {
        var result = new CaseResult { Id = id, Title = title, Index = results.Count + 1 };
        results.Add(result);
        Log.Info($"=== {id}: {title}");
        var watch = Stopwatch.StartNew();
        try
        {
            if (Wheel.Visible()) result.Add("no wheel on screen before the case", false, Wheel.Title());
            ctx.Explorer.Activate();
            body(ctx, result);
        }
        catch (Exception error)
        {
            result.Error = error.Message;
            Log.Info($"  case failed with an exception: {error}");
            result.Shot($"{id}-error", $"{id}: error {error.Message}");
        }
        finally
        {
            Input.ReleaseAll();
            if (!Wheel.WaitHidden(TimeSpan.FromSeconds(3), out _)) Log.Info("  the wheel is still visible after the case");
            if (ctx.App is { HasExited: true } gone) result.Add("OrbitDrop still running", false, $"exited with code {gone.ExitCode} (0x{gone.ExitCode:X8})");
            result.Seconds = Math.Round(watch.Elapsed.TotalSeconds, 1);
            Log.Info($"=== {id}: {(result.Passed ? "PASS" : "FAIL")} ({result.Seconds} s)");
            Thread.Sleep(800);
        }
    }

    // ------------------------------------------------------------ building blocks

    private static Native.POINT ItemPoint(System.Windows.Rect r) =>
        new((int)Math.Round(r.Left + Math.Min(r.Width / 2, 50)), (int)Math.Round(r.Top + r.Height / 2));

    /// <summary>Mouse down on the file in Explorer, move past the drag threshold (Explorer starts its OLE drag) and carry it to the activation point.</summary>
    private static bool StartFileDrag(Context ctx, CaseResult c, string file)
    {
        System.Windows.Rect? rect = ctx.Explorer.FindItem(file, TimeSpan.FromSeconds(10));
        if (!c.Add($"'{file}' found in Explorer (UI Automation)", rect != null, rect?.ToString() ?? "not in the items view")) return false;
        Native.POINT p = ItemPoint(rect!.Value);
        Input.Glide(p.X, p.Y, 250);
        Thread.Sleep(200);
        Input.LeftDown();
        Thread.Sleep(150);
        int threshold = Math.Max(Native.GetSystemMetrics(Native.SM_CXDRAG), Native.GetSystemMetrics(Native.SM_CYDRAG));
        Input.Glide(p.X + threshold + 6, p.Y + threshold + 6, 120, 2);
        Thread.Sleep(150);
        Input.Glide(ctx.Activation.X, ctx.Activation.Y, 500, 8);
        Thread.Sleep(300);
        return true;
    }

    /// <summary>
    /// Shift down (the convert combo), wait for the wheel, then a small move so OLE re-targets the
    /// drag to the wheel's IDropTarget (DragEnter). Returns null if no wheel appeared.
    /// </summary>
    private static Wheel? OpenWheel(Context ctx, CaseResult c, string expectedText, string shotName)
    {
        Input.KeyDown(Native.VK_SHIFT);
        Wheel? wheel = Wheel.WaitVisible(ctx.G, ctx.Activation, TimeSpan.FromSeconds(3), out long ms);
        if (!c.Add("wheel window shown after Shift", wheel != null, wheel == null ? "no visible OrbitDropWheelWindow within 3 s" : $"{ms} ms; {wheel}")) return null;
        double offset = Math.Sqrt(Math.Pow(wheel!.CenterX - ctx.Activation.X, 2) + Math.Pow(wheel.CenterY - ctx.Activation.Y, 2));
        c.Add("wheel centred on the pointer", offset <= 2.5, $"offset {offset:F1} px");
        string neutral = Wheel.Text();
        Log.Info($"  wheel text on open: '{neutral}'");
        Input.Glide(ctx.Activation.X + 4, ctx.Activation.Y + 3, 60, 1);
        string text = Wheel.WaitText(t => t.Length > 0 && t != ctx.G.DropHint, TimeSpan.FromSeconds(2), out bool entered);
        if (!entered)
        {
            Input.Glide(ctx.Activation.X, ctx.Activation.Y, 60, 1);
            text = Wheel.WaitText(t => t.Length > 0 && t != ctx.G.DropHint, TimeSpan.FromSeconds(2), out entered);
        }
        c.Add($"the drag entered the wheel (centre text '{expectedText}')", text == expectedText, $"wheel text '{text}' (was '{neutral}')");
        c.Shot(shotName, $"{c.Id}: wheel open, centre '{text}'");
        return wheel;
    }

    /// <summary>Glide onto a sector and wait until the wheel shows it armed (its label as the wheel text).</summary>
    private static bool ArmSector(Context ctx, CaseResult c, Wheel wheel, string menuKey, string actionId, string shotName)
    {
        (int index, int count, string label) = ctx.G.Sector(menuKey, actionId);
        Native.POINT target = wheel.SectorCenter(index, count);
        string hit = wheel.HitTest(target, count);
        Input.Glide(target.X, target.Y, 300, 6);
        string text = Wheel.WaitText(t => t == label, TimeSpan.FromSeconds(2), out bool armed);
        bool ok = c.Add($"{label} sector armed under the pointer (sector {index} of {count})", armed,
            $"aimed at {target} ({hit} by the shared hit-test); wheel text '{text}'");
        c.Shot(shotName, $"{c.Id}: pointer on {label}, wheel text '{text}'");
        return ok;
    }

    private static List<string> NewFiles(Context ctx, IEnumerable<string> before) =>
        Directory.GetFiles(ctx.Folder).Select(p => Path.GetFileName(p)!).Except(before, StringComparer.OrdinalIgnoreCase).OrderBy(n => n, StringComparer.Ordinal).ToList();

    private static List<string> Files(Context ctx) => Directory.GetFiles(ctx.Folder).Select(p => Path.GetFileName(p)!).ToList();

    /// <summary>Waits for an output file that exists, is not empty and decodes as an image.</summary>
    private static (bool ok, string detail) WaitForImage(string path, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        string last = "missing";
        while (watch.Elapsed < timeout)
        {
            if (File.Exists(path) && new FileInfo(path).Length > 0)
            {
                (bool ok, string detail) = Decode(path);
                if (ok) return (true, $"{detail} after {watch.Elapsed.TotalSeconds:F1} s");
                last = detail;
            }
            Thread.Sleep(250);
        }
        return (false, last);
    }

    private static (bool ok, string detail) Decode(string path)
    {
        try
        {
            byte[] bytes = File.ReadAllBytes(path);
            using var stream = new MemoryStream(bytes);
            using var image = System.Drawing.Image.FromStream(stream, false, true);
            string format = image.RawFormat.Equals(System.Drawing.Imaging.ImageFormat.Jpeg) ? "JPEG"
                : image.RawFormat.Equals(System.Drawing.Imaging.ImageFormat.Png) ? "PNG" : image.RawFormat.ToString();
            return (true, $"{format} {image.Width}x{image.Height}, {bytes.Length} bytes");
        }
        catch (Exception error)
        {
            return (false, $"does not decode: {error.Message}");
        }
    }

    private static void SourceUnchanged(Context ctx, CaseResult c, string name)
    {
        string path = Path.Combine(ctx.Folder, name);
        bool exists = File.Exists(path);
        string hash = exists ? Sha256(path) : "";
        c.Add($"'{name}' still in place, SHA-256 unchanged", exists && hash == ctx.Hashes[name], exists ? hash[..16] + "…" : "the source file is gone");
    }

    private static List<string> CancelReasons(Context ctx, int fromLine) =>
        ctx.AppLog.Since(fromLine, "drag session cancelled").Select(l => MainLog.Field(l, "reason") ?? "?").ToList();

    private static int Drops(Context ctx, int fromLine) => ctx.AppLog.Since(fromLine, "drop accepted").Count;

    /// <summary>A converting case: drop on a sector, then the output must appear next to the source and decode.</summary>
    private static void ConvertCase(Context ctx, CaseResult c, string source, string infoText, string menuKey, string actionId, string output, string expectedFormat, bool releaseShiftFirst)
    {
        int logStart = ctx.AppLog.LineCount;
        List<string> before = Files(ctx);
        if (!StartFileDrag(ctx, c, source)) return;
        string prefix = $"{c.Id}";
        Wheel? wheel = OpenWheel(ctx, c, infoText, $"{prefix}-1-wheel-open");
        if (wheel == null) return;
        if (c.Id == "pdf-to-jpg")
        {
            c.Add("Explorer keeps the focus while the wheel is shown", Native.GetForegroundWindow() == ctx.Explorer.Hwnd,
                $"foreground {Native.ClassName(Native.GetForegroundWindow())}");
        }
        if (releaseShiftFirst)
        {
            Input.KeyUp(Native.VK_SHIFT);
            Thread.Sleep(600);
            c.Add("the wheel stays after Shift is released", Wheel.Visible(), $"wheel text '{Wheel.Text()}'");
        }
        if (!ArmSector(ctx, c, wheel, menuKey, actionId, $"{prefix}-2-sector-armed")) return;
        Input.LeftUp();
        Thread.Sleep(100);
        Input.KeyUp(Native.VK_SHIFT);
        c.Add("the wheel hides after the drop", Wheel.WaitHidden(TimeSpan.FromSeconds(2), out long hidden), $"{hidden} ms");
        (bool ok, string detail) = WaitForImage(Path.Combine(ctx.Folder, output), TimeSpan.FromSeconds(90));
        c.Add($"'{output}' written next to '{source}' and decodes", ok && detail.StartsWith(expectedFormat, StringComparison.Ordinal), detail);
        Thread.Sleep(2500); // anything else (a second job, leftovers) would show up by now
        List<string> created = NewFiles(ctx, before);
        c.Add("exactly one new file", created.Count == 1 && string.Equals(created[0], output, StringComparison.OrdinalIgnoreCase), string.Join(", ", created));
        SourceUnchanged(ctx, c, source);
        int drops = Drops(ctx, logStart);
        c.Add("main.log: exactly one 'drop accepted'", drops == 1, $"{drops}");
        ctx.Explorer.FindItem(output, TimeSpan.FromSeconds(5));
        c.Shot($"{prefix}-3-result", $"{c.Id}: '{output}' next to '{source}' in Explorer");
    }

    // ------------------------------------------------------------ cases

    private static void Startup(Context ctx, CaseResult c)
    {
        if (ctx.App != null) c.Add("OrbitDrop.exe is running", !ctx.App.HasExited, $"pid {ctx.App.Id}");
        c.Add("main.log: native helper ready, globalDrag=true", MainLog.Field(ctx.ReadyLine, "globalDrag") == "true",
            ctx.ReadyLine.Length > 0 ? ctx.ReadyLine[(ctx.ReadyLine.IndexOf("native helper ready", StringComparison.Ordinal))..] : "");
        Process[] apps = Process.GetProcessesByName("OrbitDrop");
        Process[] helpers = Process.GetProcessesByName("OrbitDropHelper");
        c.Add("one OrbitDropHelper.exe process", helpers.Length == 1, $"{helpers.Length}");
        var appPids = new HashSet<uint>(apps.Select(p => (uint)p.Id));
        List<string> windows = Native.TopLevelWindows()
            .Where(h => Native.IsWindowVisible(h) && appPids.Contains(Native.WindowPid(h)))
            .Select(h =>
            {
                Native.GetWindowRect(h, out Native.RECT r);
                return $"{Native.ClassName(h)} '{Native.WindowText(h)}' {r}";
            })
            .Where(text => !text.EndsWith(" 0x0]", StringComparison.Ordinal))
            .ToList();
        c.Add("no OrbitDrop window on screen after the start (tray app)", windows.Count == 0, windows.Count == 0 ? "none" : string.Join("; ", windows));
        if (helpers.Length > 0)
        {
            string helperLevel = Native.IntegrityOfProcess((uint)helpers[0].Id);
            string explorerLevel = Native.IntegrityOfProcess(ctx.Explorer.Pid);
            c.Add("the helper runs at Explorer's integrity level (no UIPI block)", helperLevel == explorerLevel, $"helper {helperLevel}, Explorer {explorerLevel}");
        }
        IntPtr wheel = Wheel.FindWindow();
        c.Add("the wheel window exists, hidden, owned by the helper", wheel != IntPtr.Zero && !Native.IsWindowVisible(wheel) && helpers.Any(p => (uint)p.Id == Native.WindowPid(wheel)),
            wheel == IntPtr.Zero ? "no OrbitDropWheelWindow" : $"ex-style 0x{Native.GetWindowLongPtr(wheel, Native.GWL_EXSTYLE).ToInt64():X}");
        c.Shot("1-desktop", "startup: OrbitDrop running (tray only), Explorer on the test folder");
    }

    private static void PdfToJpg(Context ctx, CaseResult c) =>
        ConvertCase(ctx, c, PdfFixture, "PDF", "pdf", "convert.jpeg", "Page 001.jpg", "JPEG", releaseShiftFirst: false);

    private static void JpgToPng(Context ctx, CaseResult c) =>
        ConvertCase(ctx, c, JpgFixture, "JPG", "image/jpeg", "convert.png", "photo.png", "PNG", releaseShiftFirst: false);

    private static void ShiftReleased(Context ctx, CaseResult c) =>
        ConvertCase(ctx, c, "shift-up.pdf", "PDF", "pdf", "convert.jpeg", "shift-up.jpg", "JPEG", releaseShiftFirst: true);

    private static void Escape(Context ctx, CaseResult c)
    {
        const string source = "escape.pdf";
        int logStart = ctx.AppLog.LineCount;
        List<string> before = Files(ctx);
        if (!StartFileDrag(ctx, c, source)) return;
        Wheel? wheel = OpenWheel(ctx, c, "PDF", "escape-1-wheel-open");
        if (wheel == null) return;
        if (!ArmSector(ctx, c, wheel, "pdf", "convert.jpeg", "escape-2-sector-armed")) return;
        Input.Tap(Native.VK_ESCAPE);
        bool hidden = Wheel.WaitHidden(TimeSpan.FromSeconds(1.5), out long ms);
        c.Add("Esc hides the wheel (button still down)", hidden, $"{ms} ms");
        c.Shot("escape-3-after-esc", "escape: after Esc, mouse button still down");
        Thread.Sleep(300);
        Input.LeftUp();
        Input.KeyUp(Native.VK_SHIFT);
        Thread.Sleep(4000);
        c.Add("the wheel stays hidden after the release", !Wheel.Visible());
        List<string> created = NewFiles(ctx, before);
        c.Add("no output", created.Count == 0, created.Count == 0 ? "no new file" : string.Join(", ", created));
        SourceUnchanged(ctx, c, source);
        c.Add("main.log: no drop", Drops(ctx, logStart) == 0);
        List<string> reasons = CancelReasons(ctx, logStart);
        c.Add("main.log: session cancelled with reason 'escape'", reasons.Contains("escape"), string.Join(", ", reasons));
    }

    private static void OutsideRing(Context ctx, CaseResult c)
    {
        const string source = "outside.pdf";
        int logStart = ctx.AppLog.LineCount;
        List<string> before = Files(ctx);
        if (!StartFileDrag(ctx, c, source)) return;
        Wheel? wheel = OpenWheel(ctx, c, "PDF", "outside-ring-1-wheel-open");
        if (wheel == null) return;
        if (!ArmSector(ctx, c, wheel, "pdf", "convert.jpeg", "outside-ring-2-sector-armed")) return;

        // A transparent corner of the wheel's window (outside the disc, inside the window square),
        // over empty space in the source folder's own view: Explorer gets the drop there and does nothing.
        var items = ctx.Explorer.Items().Select(i => i.rect).ToList();
        Native.POINT? spot = null;
        foreach ((int dx, int dy) in new[] { (-1, 1), (1, 1), (-1, -1), (1, -1) })
        {
            Native.POINT p = wheel.Diagonal(dx, dy, 1.3);
            bool inWindow = wheel.Rect.Contains(p.X, p.Y);
            bool onItem = items.Any(r => r.Contains(new System.Windows.Point(p.X, p.Y)));
            if (inWindow && !onItem && wheel.HitTest(p, 4) == "outside")
            {
                spot = p;
                break;
            }
        }
        if (!c.Add("a transparent corner of the wheel window over empty Explorer space", spot != null, spot?.ToString() ?? "none of the four corners is free")) return;
        Native.POINT corner = spot!.Value;
        Input.Glide(corner.X, corner.Y, 300, 6);
        Thread.Sleep(400);
        IntPtr under = Native.GetAncestor(Native.WindowFromPoint(corner), Native.GA_ROOT);
        c.Add("the corner is click-through (WindowFromPoint → Explorer, not the wheel)", under == ctx.Explorer.Hwnd,
            $"{Native.ClassName(under)} '{Native.WindowText(under)}'");
        IntPtr onDisc = Native.GetAncestor(Native.WindowFromPoint(wheel.SectorCenter(1, 4)), Native.GA_ROOT);
        c.Add("the disc itself is the wheel's (WindowFromPoint on a sector)", onDisc == wheel.Hwnd, Native.ClassName(onDisc));
        string text = Wheel.Text();
        c.Add("no sector armed outside the ring", text != "JPG", $"wheel text '{text}'");
        c.Shot("outside-ring-3-corner", $"outside-ring: pointer in the wheel window's transparent corner {corner}");
        Input.LeftUp();
        Thread.Sleep(100);
        Input.KeyUp(Native.VK_SHIFT);
        c.Add("the wheel hides after the release", Wheel.WaitHidden(TimeSpan.FromSeconds(2), out long ms), $"{ms} ms");
        Thread.Sleep(4000);
        List<string> created = NewFiles(ctx, before);
        c.Add("no output", created.Count == 0, created.Count == 0 ? "no new file" : string.Join(", ", created));
        SourceUnchanged(ctx, c, source);
        c.Add("main.log: no drop", Drops(ctx, logStart) == 0);
        List<string> reasons = CancelReasons(ctx, logStart);
        c.Add("main.log: cancelled 'dragEnded' (the drop went to the window below)", reasons.Contains("dragEnded"), string.Join(", ", reasons));
    }

    private static void DeadZone(Context ctx, CaseResult c)
    {
        const string source = "deadzone.pdf";
        int logStart = ctx.AppLog.LineCount;
        List<string> before = Files(ctx);
        if (!StartFileDrag(ctx, c, source)) return;
        Wheel? wheel = OpenWheel(ctx, c, "PDF", "dead-zone-1-wheel-open");
        if (wheel == null) return;
        if (!ArmSector(ctx, c, wheel, "pdf", "convert.jpeg", "dead-zone-2-sector-armed")) return;
        Native.POINT centre = wheel.Center;
        Input.Glide(centre.X, centre.Y, 300, 6);
        string text = Wheel.WaitText(t => t == "PDF", TimeSpan.FromSeconds(2), out bool cleared);
        c.Add("no sector armed in the dead zone (centre text back to 'PDF')", cleared, $"wheel text '{text}'");
        c.Shot("dead-zone-3-centre", "dead-zone: pointer on the centre");
        Input.LeftUp();
        Thread.Sleep(100);
        Input.KeyUp(Native.VK_SHIFT);
        c.Add("the wheel hides after the release", Wheel.WaitHidden(TimeSpan.FromSeconds(2), out long ms), $"{ms} ms");
        Thread.Sleep(4000);
        List<string> created = NewFiles(ctx, before);
        c.Add("no output", created.Count == 0, created.Count == 0 ? "no new file" : string.Join(", ", created));
        SourceUnchanged(ctx, c, source);
        c.Add("main.log: no drop", Drops(ctx, logStart) == 0);
        List<string> reasons = CancelReasons(ctx, logStart);
        c.Add("main.log: cancelled 'outsideRing' (the wheel refused the release)", reasons.Contains("outsideRing"), string.Join(", ", reasons));
    }

    private static void TextDrag(Context ctx, CaseResult c)
    {
        int logStart = ctx.AppLog.LineCount;
        List<string> before = Files(ctx);
        Native.RECT work = ctx.Work;
        int w = 340;
        int h = 130;
        int x = work.Left + 20;
        int y = work.Bottom - h - 20;
        var info = new ProcessStartInfo(Environment.ProcessPath!, $"textsource --x {x} --y {y} --w {w} --h {h}")
        {
            UseShellExecute = false,
            RedirectStandardOutput = true,
            CreateNoWindow = true,
        };
        using Process source = Process.Start(info)!;
        source.OutputDataReceived += (_, e) =>
        {
            if (!string.IsNullOrEmpty(e.Data)) Log.Info($"  {e.Data}");
        };
        source.BeginOutputReadLine();
        try
        {
            IntPtr window = IntPtr.Zero;
            var watch = Stopwatch.StartNew();
            while (window == IntPtr.Zero && watch.ElapsedMilliseconds < 15000)
            {
                Thread.Sleep(200);
                window = Native.TopLevelWindows().FirstOrDefault(hw => Native.IsWindowVisible(hw) && Native.WindowText(hw) == TextSource.Title);
            }
            if (!c.Add("text source window open", window != IntPtr.Zero)) return;
            Native.GetWindowRect(window, out Native.RECT r);
            Native.POINT start = new((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2 + 8);
            Input.Click(start.X, start.Y); // activate it (a click on the label does not start a drag)
            Thread.Sleep(400);
            Input.Glide(start.X, start.Y, 100);
            Input.LeftDown();
            Thread.Sleep(150);
            Input.Glide(start.X + 12, start.Y - 12, 120, 2);
            Thread.Sleep(200);
            Input.Glide(ctx.Activation.X, ctx.Activation.Y, 500, 8);
            Thread.Sleep(300);
            Wheel? wheel = OpenWheel(ctx, c, ctx.G.NotAFile, "text-drag-1-not-a-file");
            if (wheel == null) return;
            (int index, int count, _) = ctx.G.Sector("pdf", "convert.jpeg");
            Native.POINT onSector = wheel.SectorCenter(index, count);
            Input.Glide(onSector.X, onSector.Y, 300, 6);
            Thread.Sleep(500);
            string text = Wheel.Text();
            c.Add($"still '{ctx.G.NotAFile}' over a sector (nothing armed)", text == ctx.G.NotAFile, $"wheel text '{text}'");
            // The capsule's text as drawn: one line, or lines broken at the space ("파일이" / "아님"); never
            // inside the word ("파일이 아" / "님", what the first runs showed): read from the screen's ink rows.
            List<(int top, int height, int width)> ink = wheel.CapsuleInk();
            bool wordsWhole = ink.Count == 1 || (ink.Count == 2 && ink[1].width >= 0.4 * ink[0].width);
            c.Add($"'{ctx.G.NotAFile}' in the capsule is not broken inside a word", ink.Count > 0 && wordsWhole,
                $"{ink.Count} line(s) of ink, width x height: {string.Join(" / ", ink.Select(b => $"{b.width}x{b.height} px"))}");
            c.Shot("text-drag-2-over-sector", $"text-drag: over a sector, wheel text '{text}'");
            Input.LeftUp();
            Thread.Sleep(100);
            Input.KeyUp(Native.VK_SHIFT);
            c.Add("the wheel hides after the release", Wheel.WaitHidden(TimeSpan.FromSeconds(2), out long ms), $"{ms} ms");
            Thread.Sleep(3000);
            List<string> created = NewFiles(ctx, before);
            c.Add("no output", created.Count == 0, created.Count == 0 ? "no new file" : string.Join(", ", created));
            c.Add("main.log: no drop", Drops(ctx, logStart) == 0);
            List<string> notOffered = ctx.AppLog.Since(logStart, "drag payload not offered");
            c.Add("main.log (helper): payload classified as not files", notOffered.Any(l => l.Contains("noFiles", StringComparison.Ordinal)), string.Join(" | ", notOffered.Select(l => l[(l.IndexOf("drag payload", StringComparison.Ordinal))..])));
            List<string> reasons = CancelReasons(ctx, logStart);
            c.Add("main.log: cancelled 'invalidPayload'", reasons.Contains("invalidPayload"), string.Join(", ", reasons));
        }
        finally
        {
            try
            {
                if (!source.HasExited) source.Kill();
            }
            catch
            {
                // gone
            }
        }
    }

    private static void RapidDrops(Context ctx, CaseResult c)
    {
        int logStart = ctx.AppLog.LineCount;
        List<string> before = Files(ctx);
        var watch = Stopwatch.StartNew();
        // rapid-b first: its output "rapid-b.jpg" sorts below "rapid-a.pdf", so the row of the second file cannot move
        // while the first job writes its result (Explorer sorts by name).
        foreach ((string source, int n) in new[] { ("rapid-b.pdf", 1), ("rapid-a.pdf", 2) })
        {
            if (!StartFileDrag(ctx, c, source)) return;
            Wheel? wheel = OpenWheel(ctx, c, "PDF", $"rapid-drops-{n}-wheel-open");
            if (wheel == null) return;
            if (!ArmSector(ctx, c, wheel, "pdf", "convert.jpeg", $"rapid-drops-{n}-sector-armed")) return;
            Input.LeftUp();
            Thread.Sleep(80);
            Input.KeyUp(Native.VK_SHIFT);
            Log.Info($"  drop {n} at {watch.Elapsed.TotalSeconds:F1} s");
            c.Add($"drop {n}: the wheel hides", Wheel.WaitHidden(TimeSpan.FromSeconds(2), out long ms), $"{ms} ms");
            // The second drag starts at once, while the first job may still be converting.
        }
        c.Add("both drops within 15 s", watch.Elapsed.TotalSeconds < 15, $"{watch.Elapsed.TotalSeconds:F1} s");
        foreach (string output in new[] { "rapid-a.jpg", "rapid-b.jpg" })
        {
            (bool ok, string detail) = WaitForImage(Path.Combine(ctx.Folder, output), TimeSpan.FromSeconds(90));
            c.Add($"'{output}' written and decodes", ok, detail);
        }
        Thread.Sleep(3000);
        List<string> created = NewFiles(ctx, before);
        c.Add("exactly one result per drop (2 new files)", created.SequenceEqual(new[] { "rapid-a.jpg", "rapid-b.jpg" }, StringComparer.OrdinalIgnoreCase), string.Join(", ", created));
        SourceUnchanged(ctx, c, "rapid-a.pdf");
        SourceUnchanged(ctx, c, "rapid-b.pdf");
        List<string> drops = ctx.AppLog.Since(logStart, "drop accepted");
        var sessions = drops.Select(l => MainLog.Field(l, "sessionId")).Distinct().ToList();
        c.Add("main.log: two 'drop accepted' from two sessions", drops.Count == 2 && sessions.Count == 2, $"{drops.Count} drops, sessions {string.Join(", ", sessions)}");
        ctx.Explorer.FindItem("rapid-a.jpg", TimeSpan.FromSeconds(5));
        c.Shot("rapid-drops-3-result", "rapid-drops: rapid-a.jpg and rapid-b.jpg in Explorer");
    }

    // ------------------------------------------------------------ environment and report

    private static void ShowFileExtensions()
    {
        // Explorer hides known extensions by default; show them so "Page 001.pdf" and "Page 001.jpg" differ.
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced", writable: true);
            key?.SetValue("HideFileExt", 0, RegistryValueKind.DWord);
            IntPtr state = Marshal.AllocHGlobal(64);
            try
            {
                for (int i = 0; i < 64; i += 4) Marshal.WriteInt32(state, i, 0);
                Marshal.WriteInt32(state, 0, 0x2); // fShowExtensions
                Native.SHGetSetSettings(state, Native.SSF_SHOWEXTENSIONS, true);
            }
            finally
            {
                Marshal.FreeHGlobal(state);
            }
        }
        catch (Exception error)
        {
            Log.Info($"could not turn on file extensions: {error.Message}");
        }
    }

    private static string OsText()
    {
        using RegistryKey? key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        return $"{key?.GetValue("ProductName")} {key?.GetValue("DisplayVersion")} build {key?.GetValue("CurrentBuild")}.{key?.GetValue("UBR")} ({key?.GetValue("InstallationType")})";
    }

    private static List<string> ProcessFacts()
    {
        var facts = new List<string>();
        foreach (string name in new[] { "OrbitDrop", "OrbitDropHelper", "explorer" })
        {
            foreach (Process p in Process.GetProcessesByName(name))
            {
                string path;
                try
                {
                    path = p.MainModule?.FileName ?? "?";
                }
                catch
                {
                    path = "?";
                }
                facts.Add($"{name} pid {p.Id} session {p.SessionId} integrity {Native.IntegrityOfProcess((uint)p.Id)} {path}");
                if (name == "OrbitDrop") break; // Electron's renderer/GPU/utility children share the name
            }
        }
        IntPtr wheel = Wheel.FindWindow();
        if (wheel != IntPtr.Zero)
        {
            uint pid = Native.WindowPid(wheel);
            string owner;
            try
            {
                owner = Process.GetProcessById((int)pid).ProcessName;
            }
            catch
            {
                owner = "?";
            }
            facts.Add($"wheel window class {Wheel.WindowClass} owned by {owner} (pid {pid}), ex-style 0x{Native.GetWindowLongPtr(wheel, Native.GWL_EXSTYLE).ToInt64():X}");
        }
        return facts;
    }

    private static string Sha256(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static void WriteResults(string outDir, Dictionary<string, object?> environment, List<CaseResult> results, string? fatal)
    {
        var report = new
        {
            evidence = "GitHub runner VM GUI test (synthesized input): real File Explorer and the packaged OrbitDrop, input from SendInput",
            fatal,
            environment,
            passed = fatal == null && results.Count > 0 && results.All(r => r.Passed),
            cases = results.Select(r => new { r.Id, r.Title, passed = r.Passed, r.Seconds, r.Error, r.Checks, r.Screenshots }),
        };
        File.WriteAllText(Path.Combine(outDir, "results.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));

        var md = new StringBuilder();
        md.AppendLine("## OrbitDrop Windows GUI drag test (GitHub runner VM, synthesized input)");
        md.AppendLine();
        if (fatal != null) md.AppendLine($"**Not run:** {fatal}").AppendLine();
        foreach (var (key, value) in environment.Where(e => e.Value is string))
        {
            md.AppendLine($"- {key}: `{value}`");
        }
        md.AppendLine();
        md.AppendLine("| Case | Result | Checks | Time |");
        md.AppendLine("|---|---|---|---|");
        foreach (CaseResult r in results)
        {
            string failed = string.Join("; ", r.Checks.Where(ch => !ch.Ok).Select(ch => $"{ch.What} ({ch.Detail})"));
            string note = r.Error != null ? $"error: {r.Error}" : failed.Length > 0 ? $"failed: {failed}" : $"{r.Checks.Count} checks";
            md.AppendLine($"| {r.Title} | {(r.Passed ? "PASS" : "FAIL")} | {note.Replace("|", "/")} | {r.Seconds} s |");
        }
        md.AppendLine();
        md.AppendLine("<details><summary>All checks</summary>");
        md.AppendLine();
        foreach (CaseResult r in results)
        {
            md.AppendLine($"**{r.Id}**");
            md.AppendLine();
            foreach (Check ch in r.Checks) md.AppendLine($"- {(ch.Ok ? "ok" : "FAIL")}: {ch.What}{(ch.Detail.Length > 0 ? " — " + ch.Detail.Replace("|", "/") : "")}");
            md.AppendLine();
        }
        md.AppendLine("</details>");
        Summary.Append(md.ToString());
        File.WriteAllText(Path.Combine(outDir, "summary.md"), md.ToString(), new UTF8Encoding(false));
        Log.Info($"results: {results.Count(r => r.Passed)}/{results.Count} cases passed{(fatal != null ? $" (fatal: {fatal})" : "")}");
    }
}
