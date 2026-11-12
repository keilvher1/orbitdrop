using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace OrbitDropGui;

/// <summary>
/// Desktop screenshots: BitBlt from the screen with CAPTUREBLT, so layered windows (the wheel,
/// the shell's drag image) are included. The mouse pointer itself is not captured, so a small
/// red cross marks where it is.
/// </summary>
internal static class Shots
{
    public static string? Directory { get; set; }

    /// <summary>A screen rectangle (physical pixels) as a 24-bit bitmap, layered windows included.</summary>
    public static Bitmap Capture(int x, int y, int w, int h)
    {
        var bitmap = new Bitmap(w, h, PixelFormat.Format24bppRgb);
        using Graphics g = Graphics.FromImage(bitmap);
        IntPtr dest = g.GetHdc();
        IntPtr screen = Native.GetDC(IntPtr.Zero);
        try
        {
            if (!Native.BitBlt(dest, 0, 0, w, h, screen, x, y, Native.SRCCOPY | Native.CAPTUREBLT)) throw new InvalidOperationException("BitBlt failed");
        }
        finally
        {
            Native.ReleaseDC(IntPtr.Zero, screen);
            g.ReleaseHdc(dest);
        }
        return bitmap;
    }

    public static string? Take(string name, string? note = null)
    {
        if (Directory == null) return null;
        try
        {
            int x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int w = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int h = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            using Bitmap bitmap = Capture(x, y, w, h);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                Native.POINT p = Input.Cursor();
                int px = p.X - x;
                int py = p.Y - y;
                using var outline = new Pen(Color.White, 4);
                using var pen = new Pen(Color.Red, 2);
                foreach (Pen each in new[] { outline, pen })
                {
                    g.DrawLine(each, px - 10, py, px + 10, py);
                    g.DrawLine(each, px, py - 10, px, py + 10);
                }
                if (!string.IsNullOrEmpty(note))
                {
                    using var font = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Pixel);
                    SizeF size = g.MeasureString(note, font);
                    g.FillRectangle(Brushes.Black, 0, 0, size.Width + 12, size.Height + 6);
                    g.DrawString(note, font, Brushes.White, 6, 3);
                }
            }
            System.IO.Directory.CreateDirectory(Directory);
            string path = Path.Combine(Directory, name.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ? name : name + ".png");
            bitmap.Save(path, ImageFormat.Png);
            Log.Info($"screenshot {Path.GetFileName(path)}");
            return path;
        }
        catch (Exception error)
        {
            Log.Info($"screenshot {name} failed: {error.Message}");
            return null;
        }
    }
}
