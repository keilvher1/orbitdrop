using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Windows.Automation;

namespace OrbitDropGui;

/// <summary>
/// `install`: the interactive NSIS installer, page by page, as a user goes through it — the folder page
/// (Next), the privacy page (apps/desktop/build/installer.nsh: the notice, the link and the box
/// "Check for updates automatically / 업데이트 자동 확인", ticked by default; --untick-update-check unticks
/// it), the progress page, the finish page ("Run OrbitDrop" unticked: the suite starts the app itself with
/// debug logging). Then the installation folder must hold installer-preferences.json with the choice.
///
/// The controls are found and used through UI Automation (Invoke for buttons, Toggle for check boxes), so
/// the installer works whether or not its window is in front; every page is captured on screen.
///
///   OrbitDropGuiDriver install --setup &lt;installer.exe&gt; --out &lt;dir&gt; [--untick-update-check]
/// </summary>
internal static class InstallerUi
{
    private static readonly string[] UpdateCheckLabels = { "Check for updates automatically", "업데이트 자동 확인" };
    private static readonly string[] PrivacyLinkLabels = { "Read the privacy statement", "개인정보 처리방침 전문 보기" };
    private static readonly string[] FinishLabels = { "Finish", "마침" };

    public static int Run(string outDir, Dictionary<string, string?> options)
    {
        string setup = options.GetValueOrDefault("setup") ?? throw new ArgumentException("--setup is required");
        bool untick = options.ContainsKey("untick-update-check");
        var result = new CaseResult { Id = "installer", Title = $"Interactive install: the privacy page, update check {(untick ? "unticked" : "left ticked")}", Index = 0 };
        var watch = Stopwatch.StartNew();
        string installDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "OrbitDrop");
        try
        {
            Drive(setup, untick, result, installDir);
        }
        catch (Exception error)
        {
            result.Error = error.Message;
            Log.Info($"installer case failed: {error}");
            result.Shot("installer-error", $"installer: {error.Message}");
        }
        result.Seconds = Math.Round(watch.Elapsed.TotalSeconds, 1);
        Write(outDir, result, setup);
        return result.Passed ? 0 : 3;
    }

    private static void Drive(string setup, bool untick, CaseResult c, string installDir)
    {
        if (File.Exists(Path.Combine(installDir, "OrbitDrop.exe"))) throw new InvalidOperationException($"OrbitDrop is already installed in {installDir}");
        using Process installer = Process.Start(new ProcessStartInfo(setup) { UseShellExecute = false }) ?? throw new InvalidOperationException($"could not start {setup}");
        Log.Info($"started {Path.GetFileName(setup)} (pid {installer.Id})");
        IntPtr window = WaitForWindow(installer, TimeSpan.FromSeconds(60));
        c.Add("the installer window opens", window != IntPtr.Zero, window == IntPtr.Zero ? "no window within 60 s" : $"'{Native.WindowText(window)}'");
        if (window == IntPtr.Zero) return;

        bool sawFolder = false, sawPrivacy = false, sawFinish = false;
        var deadline = Stopwatch.StartNew();
        while (!installer.HasExited && deadline.Elapsed < TimeSpan.FromMinutes(5))
        {
            Thread.Sleep(700);
            AutomationElement root;
            try
            {
                if (!Native.IsWindow(window)) window = WaitForWindow(installer, TimeSpan.FromSeconds(5));
                if (window == IntPtr.Zero) continue;
                root = AutomationElement.FromHandle(window);
            }
            catch (Exception error) when (error is ElementNotAvailableException or COMException or ArgumentException)
            {
                continue;
            }
            AutomationElement? next = Child(root, "1");
            string nextName = Clean(Name(next));
            AutomationElement? updateBox = Descendant(root, ControlType.CheckBox, UpdateCheckLabels);
            if (updateBox != null && !sawPrivacy)
            {
                sawPrivacy = true;
                c.Shot("1-privacy-page", "installer: privacy page as it opens");
                string text = string.Join(" ", root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)).Cast<AutomationElement>().Select(Name));
                c.Add("the privacy page explains the update check and names GitHub", text.Contains("GitHub", StringComparison.Ordinal), Shorten(text));
                c.Add("the privacy page links the privacy statement", Descendant(root, null, PrivacyLinkLabels) != null, "");
                ToggleState before = State(updateBox);
                c.Add($"'{Name(updateBox)}' is ticked by default", before == ToggleState.On, before.ToString());
                if (untick)
                {
                    Toggle(updateBox);
                    ToggleState after = WaitForState(updateBox, ToggleState.Off, TimeSpan.FromSeconds(3));
                    c.Add($"'{Name(updateBox)}' unticked", after == ToggleState.Off, after.ToString());
                    c.Shot("2-privacy-unticked", "installer: update check unticked");
                }
                Invoke(next, "Install");
                continue;
            }
            if (FinishLabels.Any(label => nextName.StartsWith(label, StringComparison.Ordinal)) && !sawFinish)
            {
                sawFinish = true;
                AutomationElement? run = Descendant(root, ControlType.CheckBox, null);
                if (run != null && State(run) == ToggleState.On)
                {
                    Toggle(run); // the suite starts OrbitDrop itself, with debug logging and its stdio captured
                    WaitForState(run, ToggleState.Off, TimeSpan.FromSeconds(3));
                }
                c.Add("the finish page", true, run == null ? "no run box" : $"'{Name(run)}' {State(run)}");
                c.Shot("3-finish", "installer: finish page");
                Invoke(next, "Finish");
                continue;
            }
            if (!sawPrivacy && !sawFolder && Descendant(root, ControlType.Edit, null) != null)
            {
                sawFolder = true;
                c.Shot("0-folder-page", "installer: folder page");
                Invoke(next, "Next");
            }
        }
        bool exited = installer.WaitForExit(30_000);
        c.Add("the installer went through the folder, privacy and finish pages and exited", exited && sawFolder && sawPrivacy && sawFinish,
            $"folder={sawFolder} privacy={sawPrivacy} finish={sawFinish} exit={(exited ? installer.ExitCode.ToString() : "still running")}");

        string exe = Path.Combine(installDir, "OrbitDrop.exe");
        c.Add("OrbitDrop.exe installed for the current user", File.Exists(exe), exe);
        string prefs = Path.Combine(installDir, "installer-preferences.json");
        string text2 = File.Exists(prefs) ? File.ReadAllText(prefs).Trim() : "(missing)";
        bool? autoCheck = null;
        try
        {
            using JsonDocument doc = JsonDocument.Parse(text2);
            autoCheck = doc.RootElement.GetProperty("updates").GetProperty("autoCheck").GetBoolean();
        }
        catch (Exception error) when (error is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            // reported below
        }
        c.Add($"installer-preferences.json records the choice (autoCheck {(!untick).ToString().ToLowerInvariant()})", autoCheck == !untick, text2);
        foreach (Process app in Process.GetProcessesByName("OrbitDrop"))
        {
            Log.Info($"OrbitDrop (pid {app.Id}) is running after the install; stopping it so the suite starts it fresh");
            try
            {
                app.Kill(entireProcessTree: true);
            }
            catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                // gone already
            }
        }
    }

    // ------------------------------------------------------------ UI Automation helpers

    private static IntPtr WaitForWindow(Process installer, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        while (watch.Elapsed < timeout && !installer.HasExited)
        {
            IntPtr found = Native.TopLevelWindows().FirstOrDefault(h => Native.IsWindowVisible(h) && Native.WindowPid(h) == (uint)installer.Id && Native.ClassName(h) == "#32770");
            if (found != IntPtr.Zero) return found;
            Thread.Sleep(250);
        }
        return IntPtr.Zero;
    }

    private static string Name(AutomationElement? element)
    {
        try
        {
            return element?.Current.Name ?? "";
        }
        catch (ElementNotAvailableException)
        {
            return "";
        }
    }

    /// <summary>A button text without its mnemonic ("&amp;Finish" → "Finish") and the "&gt;" of "Next &gt;".</summary>
    private static string Clean(string name) => name.Replace("&", "", StringComparison.Ordinal).Replace(">", "", StringComparison.Ordinal).Trim();

    private static string Shorten(string text) => text.Length <= 160 ? text : text[..160] + "…";

    /// <summary>The outer dialog's own control with this Win32 id (1 = Next/Install/Finish).</summary>
    private static AutomationElement? Child(AutomationElement root, string automationId) =>
        root.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.AutomationIdProperty, automationId));

    private static AutomationElement? Descendant(AutomationElement root, ControlType? type, string[]? names)
    {
        Condition condition = type == null ? Condition.TrueCondition : new PropertyCondition(AutomationElement.ControlTypeProperty, type);
        foreach (AutomationElement element in root.FindAll(TreeScope.Descendants, condition))
        {
            string name = Clean(Name(element));
            if (names == null || names.Contains(name)) return element;
        }
        return null;
    }

    private static ToggleState State(AutomationElement element) =>
        element.TryGetCurrentPattern(TogglePattern.Pattern, out object pattern) ? ((TogglePattern)pattern).Current.ToggleState : ToggleState.Indeterminate;

    private static void Toggle(AutomationElement element)
    {
        if (!element.TryGetCurrentPattern(TogglePattern.Pattern, out object pattern)) throw new InvalidOperationException($"'{Name(element)}' cannot be toggled");
        ((TogglePattern)pattern).Toggle();
        Log.Info($"toggled '{Name(element)}'");
    }

    private static ToggleState WaitForState(AutomationElement element, ToggleState wanted, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        ToggleState state;
        do
        {
            state = State(element);
            if (state == wanted) return state;
            Thread.Sleep(100);
        } while (watch.Elapsed < timeout);
        return state;
    }

    private static void Invoke(AutomationElement? button, string what)
    {
        if (button == null) throw new InvalidOperationException($"no {what} button");
        if (!button.TryGetCurrentPattern(InvokePattern.Pattern, out object pattern)) throw new InvalidOperationException($"'{Name(button)}' cannot be pressed");
        Log.Info($"press '{Name(button)}' ({what})");
        ((InvokePattern)pattern).Invoke();
    }

    private static void Write(string outDir, CaseResult result, string setup)
    {
        var report = new
        {
            evidence = "GitHub runner VM: the interactive NSIS installer, driven through UI Automation",
            installer = Path.GetFileName(setup),
            passed = result.Passed,
            result.Seconds,
            result.Error,
            result.Checks,
            result.Screenshots,
        };
        File.WriteAllText(Path.Combine(outDir, "install-results.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }), new UTF8Encoding(false));
        var md = new StringBuilder();
        md.AppendLine("## OrbitDrop installer: privacy page (interactive, GitHub runner VM)");
        md.AppendLine();
        md.AppendLine($"**{(result.Passed ? "PASS" : "FAIL")}** · `{Path.GetFileName(setup)}` · {result.Seconds} s{(result.Error != null ? $" · error: {result.Error}" : "")}");
        md.AppendLine();
        foreach (Check ch in result.Checks) md.AppendLine($"- {(ch.Ok ? "ok" : "FAIL")}: {ch.What}{(ch.Detail.Length > 0 ? " — " + ch.Detail.Replace("|", "/") : "")}");
        Summary.Append(md.ToString());
        Log.Info($"installer: {(result.Passed ? "PASS" : "FAIL")} ({result.Checks.Count(ch => ch.Ok)}/{result.Checks.Count} checks)");
    }
}
