using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace OrbitDropGui;

/// <summary>
/// Desktop screenshots. CopyFromScreen with CaptureBlt so layered windows (the
/// wheel, the shell's drag image) are included. The mouse pointer itself is not
/// captured, so a small red cross marks where it is.
/// </summary>
internal static class Shots
{
    public static string? Directory { get; set; }

    public static string? Take(string name, string? note = null)
    {
        if (Directory == null) return null;
        try
        {
            int x = Native.GetSystemMetrics(Native.SM_XVIRTUALSCREEN);
            int y = Native.GetSystemMetrics(Native.SM_YVIRTUALSCREEN);
            int w = Native.GetSystemMetrics(Native.SM_CXVIRTUALSCREEN);
            int h = Native.GetSystemMetrics(Native.SM_CYVIRTUALSCREEN);
            using var bitmap = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy | CopyPixelOperation.CaptureBlt);
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
                    using var font = new Font("Segoe UI", 10f, FontStyle.Bold, GraphicsUnit.Pixel);
                    SizeF size = g.MeasureString(note, font);
                    g.FillRectangle(Brushes.Black, 0, h - size.Height - 6, size.Width + 12, size.Height + 6);
                    g.DrawString(note, font, Brushes.White, 6, h - size.Height - 3);
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

    /// <summary>The colour of one screen pixel (null when the screen cannot be read).</summary>
    public static Color? Pixel(int x, int y)
    {
        try
        {
            using var bitmap = new Bitmap(1, 1, PixelFormat.Format32bppArgb);
            using (Graphics g = Graphics.FromImage(bitmap))
            {
                g.CopyFromScreen(x, y, 0, 0, new Size(1, 1), CopyPixelOperation.SourceCopy | CopyPixelOperation.CaptureBlt);
            }
            return bitmap.GetPixel(0, 0);
        }
        catch
        {
            return null;
        }
    }
}
