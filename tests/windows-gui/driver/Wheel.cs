using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;

namespace OrbitDropGui;

/// <summary>The wheel geometry, menus and centre texts exported from packages/contracts (tests/windows-gui/geometry.mjs).</summary>
internal sealed class SharedGeometry
{
    public double Diameter { get; private init; }
    public double InnerRadiusRatio { get; private init; }
    public double StartAngleDeg { get; private init; }
    public double ArmDistance { get; private init; }
    public double EdgePadding { get; private init; }
    public double CaptionGap { get; private init; }
    public double CaptionHeight { get; private init; }
    public string DropHint { get; private init; } = "";
    public string NotAFile { get; private init; } = "";
    public Dictionary<string, List<(string actionId, string label)>> Menus { get; } = new();

    public static SharedGeometry Load(string path)
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(path));
        JsonElement root = doc.RootElement;
        JsonElement g = root.GetProperty("geometry");
        JsonElement strip = root.GetProperty("captionStrip");
        JsonElement strings = root.GetProperty("strings");
        var shared = new SharedGeometry
        {
            Diameter = g.GetProperty("diameter").GetDouble(),
            InnerRadiusRatio = g.GetProperty("innerRadiusRatio").GetDouble(),
            StartAngleDeg = g.GetProperty("startAngleDeg").GetDouble(),
            ArmDistance = g.GetProperty("armDistance").GetDouble(),
            EdgePadding = g.GetProperty("edgePadding").GetDouble(),
            CaptionGap = strip.GetProperty("gap").GetDouble(),
            CaptionHeight = strip.GetProperty("height").GetDouble(),
            DropHint = strings.GetProperty("dropHint").GetString() ?? "",
            NotAFile = strings.GetProperty("unsupportedNonFile").GetString() ?? "",
        };
        foreach (JsonProperty menu in root.GetProperty("menus").EnumerateObject())
        {
            var sectors = new List<(string, string)>();
            foreach (JsonElement s in menu.Value.EnumerateArray()) sectors.Add((s.GetProperty("actionId").GetString()!, s.GetProperty("label").GetString()!));
            shared.Menus[menu.Name] = sectors;
        }
        return shared;
    }

    public (int index, int count, string label) Sector(string menuKey, string actionId)
    {
        List<(string actionId, string label)> sectors = Menus[menuKey];
        int index = sectors.FindIndex(s => s.actionId == actionId);
        if (index < 0) throw new InvalidOperationException($"{actionId} is not in the {menuKey} menu");
        return (index, sectors.Count, sectors[index].label);
    }
}

/// <summary>
/// The helper's wheel window (class OrbitDropWheelWindow: layered, topmost, no-activate) as seen
/// from outside: its rectangle, the disc centre derived from it with the shared geometry, and
/// its title, which the helper keeps at "OrbitDrop 휠: &lt;centre text or armed sector&gt;".
/// </summary>
internal sealed class Wheel
{
    public const string WindowClass = "OrbitDropWheelWindow";

    public IntPtr Hwnd { get; private init; }
    public Native.RECT Rect { get; private init; }
    public uint Dpi { get; private init; }
    public double Scale => Dpi / 96.0;
    public double CenterX { get; private init; }
    public double CenterY { get; private init; }
    public double Radius { get; private init; }
    public string Placement { get; private init; } = "";
    public SharedGeometry Geometry { get; private init; } = null!;

    public static IntPtr FindWindow()
    {
        IntPtr hidden = IntPtr.Zero;
        foreach (IntPtr h in Native.TopLevelWindows())
        {
            if (Native.ClassName(h) != WindowClass) continue;
            if (Native.IsWindowVisible(h)) return h;
            if (hidden == IntPtr.Zero) hidden = h;
        }
        return hidden;
    }

    public static bool Visible()
    {
        IntPtr h = FindWindow();
        return h != IntPtr.Zero && Native.IsWindowVisible(h);
    }

    public static string Title()
    {
        IntPtr h = FindWindow();
        return h == IntPtr.Zero ? "" : Native.WindowText(h);
    }

    /// <summary>The text after "OrbitDrop 휠: " (the centre text or the armed sector's label).</summary>
    public static string Text()
    {
        string title = Title();
        int colon = title.IndexOf(": ", StringComparison.Ordinal);
        return colon < 0 ? "" : title[(colon + 2)..];
    }

    /// <summary>Waits until the wheel is visible (the helper shows it ~40 ms after the combo is complete).</summary>
    public static Wheel? WaitVisible(SharedGeometry g, Native.POINT activation, TimeSpan timeout, out long elapsedMs)
    {
        var watch = Stopwatch.StartNew();
        IntPtr h = IntPtr.Zero;
        while (watch.Elapsed < timeout)
        {
            h = FindWindow();
            if (h != IntPtr.Zero && Native.IsWindowVisible(h)) break;
            Thread.Sleep(10);
        }
        elapsedMs = watch.ElapsedMilliseconds;
        if (h == IntPtr.Zero || !Native.IsWindowVisible(h)) return null;
        Thread.Sleep(200); // the fade-in only changes the constant alpha; position and size are final when shown
        Native.GetWindowRect(h, out Native.RECT r);
        uint dpi = Native.GetDpiForWindow(h);
        if (dpi == 0) dpi = Native.DpiForPoint((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2);
        double s = dpi / 96.0;
        double radius = g.Diameter / 2 * s;
        // The window is the disc's bounding square (+ the caption strip below or above it), one pixel
        // larger on each side (docs/workstreams/windows-helper.md, "Coordinates").
        double cx = (r.Left + r.Right) / 2.0;
        double square = g.Diameter * s + 2;
        string placement;
        double cy;
        if (Math.Abs(r.Height - square) <= 3)
        {
            placement = "none";
            cy = (r.Top + r.Bottom) / 2.0;
        }
        else
        {
            double below = r.Top + 1 + radius;
            double above = r.Bottom - 1 - radius;
            bool isBelow = Math.Abs(below - activation.Y) <= Math.Abs(above - activation.Y);
            placement = isBelow ? "below" : "above";
            cy = isBelow ? below : above;
        }
        return new Wheel { Hwnd = h, Rect = r, Dpi = dpi, CenterX = cx, CenterY = cy, Radius = radius, Placement = placement, Geometry = g };
    }

    public static bool WaitHidden(TimeSpan timeout, out long elapsedMs)
    {
        var watch = Stopwatch.StartNew();
        while (watch.Elapsed < timeout)
        {
            if (!Visible())
            {
                elapsedMs = watch.ElapsedMilliseconds;
                return true;
            }
            Thread.Sleep(10);
        }
        elapsedMs = watch.ElapsedMilliseconds;
        return false;
    }

    /// <summary>Waits for the wheel's text to satisfy `match`; returns the last text seen.</summary>
    public static string WaitText(Func<string, bool> match, TimeSpan timeout, out bool matched)
    {
        var watch = Stopwatch.StartNew();
        string text = Text();
        while (!(matched = match(text)) && watch.Elapsed < timeout)
        {
            Thread.Sleep(15);
            text = Text();
        }
        return text;
    }

    public Native.POINT Center => new((int)Math.Round(CenterX), (int)Math.Round(CenterY));

    /// <summary>Centre of sector `index` of `count`: halfway between the dead zone and the outer edge, at the sector's centre angle.</summary>
    public Native.POINT SectorCenter(int index, int count)
    {
        double angle = (Geometry.StartAngleDeg + index * 360.0 / count) * Math.PI / 180.0;
        double r = Radius * (1 + Geometry.InnerRadiusRatio) / 2;
        return new Native.POINT((int)Math.Round(CenterX + r * Math.Cos(angle)), (int)Math.Round(CenterY + r * Math.Sin(angle)));
    }

    /// <summary>A point at `factor` × radius along a diagonal (factor &gt; 1: outside the disc, in the window's transparent corner).</summary>
    public Native.POINT Diagonal(int dx, int dy, double factor)
    {
        double d = Radius * factor / Math.Sqrt(2);
        return new Native.POINT((int)Math.Round(CenterX + dx * d), (int)Math.Round(CenterY + dy * d));
    }

    /// <summary>packages/core hitTestWheel for a screen pixel: "center", "outside" or "sector N".</summary>
    public string HitTest(Native.POINT p, int count)
    {
        double dx = (p.X - CenterX) / Scale;
        double dy = (p.Y - CenterY) / Scale;
        double r = Math.Sqrt(dx * dx + dy * dy);
        if (r <= Geometry.Diameter / 2 * Geometry.InnerRadiusRatio) return "center";
        if (r > Geometry.Diameter / 2) return "outside";
        double angle = Math.Atan2(dy, dx) * 180 / Math.PI;
        double span = 360.0 / count;
        double rel = (angle - Geometry.StartAngleDeg + span / 2) % 360;
        if (rel < 0) rel += 360;
        return $"sector {Math.Min(count - 1, (int)Math.Floor(rel / span))}";
    }

    public override string ToString() =>
        $"window {Rect} at {Dpi} dpi, disc centre ({CenterX:F1},{CenterY:F1}) radius {Radius:F1} px, caption strip {Placement}";
}
