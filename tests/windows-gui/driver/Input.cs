using System;
using System.Runtime.InteropServices;
using System.Threading;

namespace OrbitDropGui;

/// <summary>
/// Synthesized mouse and keyboard input (SendInput). Absolute moves use the
/// virtual desktop's normalized 0..65535 space; the driver is Per-Monitor DPI
/// aware, so every coordinate here is a physical screen pixel.
/// </summary>
internal static class Input
{
    private static readonly int InputSize = Marshal.SizeOf<Native.INPUT>();

    public static int FailedSends { get; private set; }

    private static void Send(Native.INPUT input)
    {
        uint sent = Native.SendInput(1, new[] { input }, InputSize);
        if (sent != 1)
        {
            FailedSends += 1;
            Log.Info($"SendInput inserted {sent} events (error {Marshal.GetLastWin32Error()})");
        }
    }

    public static Native.POINT Cursor()
    {
        Native.GetCursorPos(out Native.POINT p);
        return p;
    }

    public static void MoveTo(int x, int y)
    {
        int vx = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
        int vy = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
        int vw = Math.Max(2, Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN));
        int vh = Math.Max(2, Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN));
        int nx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
        int ny = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
        var input = new Native.INPUT
        {
            type = Native.INPUT_MOUSE,
            u = new Native.InputUnion
            {
                mi = new Native.MOUSEINPUT
                {
                    dx = nx,
                    dy = ny,
                    dwFlags = Native.MOUSEEVENTF_MOVE | Native.MOUSEEVENTF_ABSOLUTE | Native.MOUSEEVENTF_VIRTUALDESK | Native.MOUSEEVENTF_MOVE_NOCOALESCE,
                },
            },
        };
        Send(input);
    }

    /// <summary>Move in small steps (a real drag needs intermediate mouse moves for OLE's drag loop).</summary>
    public static void Glide(int x, int y, int durationMs = 300, double stepPx = 6)
    {
        Native.POINT from = Cursor();
        double dx = x - from.X;
        double dy = y - from.Y;
        double distance = Math.Sqrt(dx * dx + dy * dy);
        int steps = Math.Max(1, (int)Math.Ceiling(distance / stepPx));
        int delay = Math.Max(5, durationMs / steps);
        for (int i = 1; i <= steps; i++)
        {
            double t = (double)i / steps;
            MoveTo((int)Math.Round(from.X + dx * t), (int)Math.Round(from.Y + dy * t));
            Thread.Sleep(delay);
        }
        Native.POINT end = Cursor();
        if (end.X != x || end.Y != y) Log.Info($"glide ended at {end} instead of ({x},{y})");
    }

    private static void Button(uint flag)
    {
        var input = new Native.INPUT
        {
            type = Native.INPUT_MOUSE,
            u = new Native.InputUnion { mi = new Native.MOUSEINPUT { dwFlags = flag } },
        };
        Send(input);
    }

    public static void LeftDown() => Button(Native.MOUSEEVENTF_LEFTDOWN);

    public static void LeftUp() => Button(Native.MOUSEEVENTF_LEFTUP);

    public static void Click(int x, int y)
    {
        Glide(x, y, 150);
        Thread.Sleep(80);
        LeftDown();
        Thread.Sleep(60);
        LeftUp();
    }

    private static void Key(int vk, bool up)
    {
        var input = new Native.INPUT
        {
            type = Native.INPUT_KEYBOARD,
            u = new Native.InputUnion
            {
                ki = new Native.KEYBDINPUT
                {
                    wVk = (ushort)vk,
                    wScan = (ushort)Native.MapVirtualKeyW((uint)vk, 0),
                    dwFlags = up ? Native.KEYEVENTF_KEYUP : 0,
                },
            },
        };
        Send(input);
    }

    public static void KeyDown(int vk) => Key(vk, false);

    public static void KeyUp(int vk) => Key(vk, true);

    public static void Tap(int vk)
    {
        KeyDown(vk);
        Thread.Sleep(40);
        KeyUp(vk);
    }

    public static bool IsDown(int vk) => (Native.GetAsyncKeyState(vk) & 0x8000) != 0;

    /// <summary>Leave no button or modifier pressed (after a failed step).</summary>
    public static void ReleaseAll()
    {
        if (IsDown(Native.VK_LBUTTON)) LeftUp();
        foreach (int vk in new[] { Native.VK_SHIFT, Native.VK_CONTROL, Native.VK_MENU })
        {
            if (IsDown(vk)) KeyUp(vk);
        }
    }
}
