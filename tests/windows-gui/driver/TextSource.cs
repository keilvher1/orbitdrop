using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading;
using System.Windows.Forms;

namespace OrbitDropGui;

/// <summary>
/// `textsource`: a small window whose label starts an ordinary OLE drag of plain text
/// (CF_UNICODETEXT, no file list) when dragged with the mouse — the "not a file" case.
/// Windows Server has no WordPad, and Notepad's edit control cannot drag text out.
/// </summary>
internal static class TextSource
{
    public const string Title = "OrbitDrop GUI test - text source";
    public const string Text = "OrbitDrop GUI test: plain text, not a file";

    public static int Run(Dictionary<string, string?> options)
    {
        int x = int.Parse(options.GetValueOrDefault("x") ?? "60");
        int y = int.Parse(options.GetValueOrDefault("y") ?? "60");
        int w = int.Parse(options.GetValueOrDefault("w") ?? "420");
        int h = int.Parse(options.GetValueOrDefault("h") ?? "160");
        int exitCode = 0;
        var thread = new Thread(() =>
        {
            Application.EnableVisualStyles();
            var form = new Form
            {
                Text = Title,
                StartPosition = FormStartPosition.Manual,
                Bounds = new Rectangle(x, y, w, h),
                FormBorderStyle = FormBorderStyle.FixedToolWindow,
                BackColor = Color.White,
            };
            var label = new Label
            {
                Name = "dragText",
                Text = Text,
                Dock = DockStyle.Fill,
                TextAlign = ContentAlignment.MiddleCenter,
                Font = new Font("Segoe UI", 12f),
                BackColor = Color.LightYellow,
                AccessibleName = "dragText",
            };
            Point? down = null;
            label.MouseDown += (_, e) => down = e.Button == MouseButtons.Left ? e.Location : null;
            label.MouseUp += (_, _) => down = null;
            label.MouseMove += (_, e) =>
            {
                if (down is not Point start || (e.Button & MouseButtons.Left) == 0) return;
                Size drag = SystemInformation.DragSize;
                if (Math.Abs(e.X - start.X) <= drag.Width / 2 && Math.Abs(e.Y - start.Y) <= drag.Height / 2) return;
                down = null;
                DragDropEffects result = label.DoDragDrop(Text, DragDropEffects.Copy | DragDropEffects.Move);
                Console.WriteLine($"textsource: DoDragDrop returned {result}");
            };
            form.Controls.Add(label);
            Application.Run(form);
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        thread.Join();
        return exitCode;
    }
}
