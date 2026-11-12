using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;

namespace OrbitDropGui;

/// <summary>
/// OrbitDrop's own log (%APPDATA%\OrbitDrop\logs\main.log, ORBITDROP_DEBUG=1), read while the app
/// writes it. With ORBITDROP_HELPER_DEBUG=1 the helper's diagnostics are in it too ("helper: …").
/// Lines carry ids, codes and counts, never paths.
/// </summary>
internal sealed class MainLog
{
    private readonly string path;

    public MainLog(string path)
    {
        this.path = path;
    }

    public string FilePath => path;

    public List<string> Lines()
    {
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            return reader.ReadToEnd().Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToList();
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return new List<string>();
        }
    }

    public int LineCount => Lines().Count;

    /// <summary>Lines after the first `skip` lines that contain `needle`.</summary>
    public List<string> Since(int skip, string needle) => Lines().Skip(skip).Where(l => l.Contains(needle, StringComparison.Ordinal)).ToList();

    public string? WaitFor(Func<string, bool> match, TimeSpan timeout, int skip = 0)
    {
        var watch = Stopwatch.StartNew();
        do
        {
            string? line = Lines().Skip(skip).FirstOrDefault(match);
            if (line != null) return line;
            Thread.Sleep(250);
        } while (watch.Elapsed < timeout);
        return null;
    }

    /// <summary>The value of key="value" or key=value in a log line.</summary>
    public static string? Field(string line, string key)
    {
        int at = line.IndexOf(" " + key + "=", StringComparison.Ordinal);
        if (at < 0) return null;
        int start = at + key.Length + 2;
        if (start < line.Length && line[start] == '"')
        {
            int end = line.IndexOf('"', start + 1);
            return end < 0 ? line[(start + 1)..] : line[(start + 1)..end];
        }
        int stop = line.IndexOf(' ', start);
        return stop < 0 ? line[start..] : line[start..stop];
    }
}
