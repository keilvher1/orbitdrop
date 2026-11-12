using System;
using System.IO;
using System.Text;

namespace OrbitDropGui;

/// <summary>Timestamped console log, mirrored to &lt;out&gt;/driver.log.</summary>
internal static class Log
{
    private static readonly object Gate = new();
    private static StreamWriter? file;
    private static readonly DateTime Started = DateTime.UtcNow;

    public static void Open(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        file = new StreamWriter(path, append: true, new UTF8Encoding(false)) { AutoFlush = true };
    }

    public static void Info(string message)
    {
        string line = $"{DateTime.UtcNow:HH:mm:ss.fff} +{(DateTime.UtcNow - Started).TotalSeconds,7:F2}s {message}";
        lock (Gate)
        {
            Console.WriteLine(line);
            file?.WriteLine(line);
        }
    }
}
