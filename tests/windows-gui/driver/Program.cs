using System;
using System.Collections.Generic;
using System.IO;

namespace OrbitDropGui;

/// <summary>
/// OrbitDrop Windows GUI driver (CI only: it synthesizes real mouse and keyboard input).
///
///   OrbitDropGuiDriver probe --out &lt;dir&gt;
///   OrbitDropGuiDriver suite --out &lt;dir&gt; --work &lt;dir&gt; --geometry &lt;json&gt; --main-log &lt;main.log&gt;
///   OrbitDropGuiDriver textsource            (a small window that drags plain text: the non-file case)
///
/// Exit code 0 = everything passed, 3 = a check failed, 2 = usage / environment error.
/// </summary>
internal static class Program
{
    private static int Main(string[] args)
    {
        // The manifest already asks for Per-Monitor V2; this covers a manifest that was not applied.
        Native.SetProcessDpiAwarenessContext(Native.DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        if (args.Length == 0)
        {
            Console.Error.WriteLine("usage: OrbitDropGuiDriver probe|suite|textsource [options]");
            return 2;
        }
        var options = ParseOptions(args);
        string command = args[0];
        if (command == "textsource") return TextSource.Run(options);
        if (Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true" && !options.ContainsKey("i-know-this-moves-the-mouse"))
        {
            Console.Error.WriteLine("Refusing to run outside GitHub Actions: this driver takes over the mouse and keyboard.");
            return 2;
        }
        string outDir = Path.GetFullPath(options.GetValueOrDefault("out") ?? "gui-out");
        Directory.CreateDirectory(outDir);
        Log.Open(Path.Combine(outDir, "driver.log"));
        Shots.Directory = Path.Combine(outDir, "screenshots");
        try
        {
            return command switch
            {
                "probe" => Probe.Run(outDir),
                "suite" => Suite.Run(outDir, options),
                _ => Usage(command),
            };
        }
        catch (Exception error)
        {
            Log.Info($"driver crashed: {error}");
            Shots.Take("driver-crash", "driver crashed");
            return 2;
        }
        finally
        {
            Input.ReleaseAll();
        }
    }

    private static int Usage(string command)
    {
        Console.Error.WriteLine($"unknown command '{command}'");
        return 2;
    }

    private static Dictionary<string, string?> ParseOptions(string[] args)
    {
        var options = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < args.Length; i++)
        {
            if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
            string key = args[i][2..];
            string? value = i + 1 < args.Length && !args[i + 1].StartsWith("--", StringComparison.Ordinal) ? args[++i] : null;
            options[key] = value;
        }
        return options;
    }
}
