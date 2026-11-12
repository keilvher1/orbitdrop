using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace OrbitDropGui;

/// <summary>
/// Starts the installed OrbitDrop.exe the way the test needs it: debug logging for main
/// (ORBITDROP_DEBUG=1) and the helper (ORBITDROP_HELPER_DEBUG=1, inherited by the helper), its
/// stdout/stderr captured to files, and its exit reported. The profile is the default one
/// (%APPDATA%\OrbitDrop); packaged builds do not honour ORBITDROP_USER_DATA_DIR, and the
/// workflow checks that the folder does not exist yet.
/// </summary>
internal static class AppProcess
{
    public static Process Start(string exe, string stdioDir)
    {
        Directory.CreateDirectory(stdioDir);
        var info = new ProcessStartInfo(exe)
        {
            UseShellExecute = false,
            WorkingDirectory = Path.GetDirectoryName(exe)!,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        info.Environment["ORBITDROP_DEBUG"] = "1";
        info.Environment["ORBITDROP_HELPER_DEBUG"] = "1";
        // Chromium's own log lines on stderr too (a renderer/GPU crash or a FATAL shows up there).
        info.Environment["ELECTRON_ENABLE_LOGGING"] = "1";
        Process app = Process.Start(info) ?? throw new InvalidOperationException($"could not start {exe}");
        app.StandardInput.Close(); // OrbitDrop reads nothing on stdin
        var stdout = new StreamWriter(Path.Combine(stdioDir, "orbitdrop-stdout.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
        var stderr = new StreamWriter(Path.Combine(stdioDir, "orbitdrop-stderr.log"), false, new UTF8Encoding(false)) { AutoFlush = true };
        app.OutputDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (stdout) stdout.WriteLine(e.Data);
        };
        app.ErrorDataReceived += (_, e) =>
        {
            if (e.Data == null) return;
            lock (stderr) stderr.WriteLine(e.Data);
        };
        app.EnableRaisingEvents = true;
        app.Exited += (_, _) => Log.Info($"OrbitDrop (pid {app.Id}) exited with code {app.ExitCode} (0x{app.ExitCode:X8})");
        app.BeginOutputReadLine();
        app.BeginErrorReadLine();
        Log.Info($"started {exe} (pid {app.Id}) with ORBITDROP_DEBUG=1 ORBITDROP_HELPER_DEBUG=1");
        return app;
    }
}
