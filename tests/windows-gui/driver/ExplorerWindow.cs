using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

namespace OrbitDropGui;

/// <summary>A real File Explorer window on one folder, and its items found through UI Automation.</summary>
internal sealed class ExplorerWindow
{
    public IntPtr Hwnd { get; }
    public string Folder { get; }

    private ExplorerWindow(IntPtr hwnd, string folder)
    {
        Hwnd = hwnd;
        Folder = folder;
    }

    public Native.RECT Rect
    {
        get
        {
            Native.GetWindowRect(Hwnd, out Native.RECT r);
            return r;
        }
    }

    public uint Pid => Native.WindowPid(Hwnd);

    private static List<IntPtr> CabinetWindows() =>
        Native.TopLevelWindows().Where(h => Native.IsWindowVisible(h) && Native.ClassName(h) == "CabinetWClass").ToList();

    /// <summary>Opens the folder in a new Explorer window, then moves and sizes it (physical pixels).</summary>
    public static ExplorerWindow Open(string folder, Native.RECT bounds, TimeSpan timeout)
    {
        var before = new HashSet<IntPtr>(CabinetWindows());
        string leaf = Path.GetFileName(folder.TrimEnd('\\'));
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{folder}\"") { UseShellExecute = false })?.Dispose();
        var watch = Stopwatch.StartNew();
        IntPtr hwnd = IntPtr.Zero;
        while (watch.Elapsed < timeout && hwnd == IntPtr.Zero)
        {
            Thread.Sleep(250);
            // A new window titled after the folder ("<folder> - File Explorer"); an older one only if nothing new shows up.
            var titled = CabinetWindows().Where(h => Native.WindowText(h).StartsWith(leaf, StringComparison.OrdinalIgnoreCase)).ToList();
            IntPtr fresh = titled.FirstOrDefault(h => !before.Contains(h));
            if (fresh != IntPtr.Zero) hwnd = fresh;
            else if (watch.Elapsed > TimeSpan.FromSeconds(5) && titled.Count > 0) hwnd = titled[0];
        }
        if (hwnd == IntPtr.Zero) throw new InvalidOperationException($"no Explorer window for '{leaf}' within {timeout.TotalSeconds:F0} s");
        Log.Info($"explorer window 0x{hwnd.ToInt64():X} '{Native.WindowText(hwnd)}' pid {Native.WindowPid(hwnd)} after {watch.ElapsedMilliseconds} ms");
        Native.ShowWindow(hwnd, Native.SW_RESTORE);
        Native.SetWindowPos(hwnd, IntPtr.Zero, bounds.Left, bounds.Top, bounds.Width, bounds.Height, Native.SWP_NOZORDER | Native.SWP_SHOWWINDOW);
        Thread.Sleep(500);
        return new ExplorerWindow(hwnd, folder);
    }

    /// <summary>Bring the window to the front with a click on its caption area (what a user would do).</summary>
    public void Activate()
    {
        if (Native.GetForegroundWindow() == Hwnd) return;
        Native.SetForegroundWindow(Hwnd);
        Thread.Sleep(200);
        if (Native.GetForegroundWindow() == Hwnd) return;
        Native.RECT r = Rect;
        Input.Click(r.Right - 260, r.Top + 14);
        Thread.Sleep(400);
        Log.Info($"activate explorer: foreground is {(Native.GetForegroundWindow() == Hwnd ? "explorer" : Native.ClassName(Native.GetForegroundWindow()))}");
    }

    public void Close()
    {
        try
        {
            AutomationElement root = AutomationElement.FromHandle(Hwnd);
            if (root.TryGetCurrentPattern(WindowPattern.Pattern, out object pattern)) ((WindowPattern)pattern).Close();
        }
        catch (Exception error)
        {
            Log.Info($"closing explorer window failed: {error.Message}");
        }
        Thread.Sleep(500);
        if (Native.IsWindow(Hwnd) && Native.IsWindowVisible(Hwnd)) Native.PostMessageW(Hwnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
    }

    /// <summary>Every list item (file or folder) currently shown in the items view.</summary>
    public List<(string name, System.Windows.Rect rect, AutomationElement element)> Items()
    {
        var result = new List<(string, System.Windows.Rect, AutomationElement)>();
        AutomationElement root = AutomationElement.FromHandle(Hwnd);
        AutomationElementCollection items = root.FindAll(TreeScope.Descendants, new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.ListItem));
        foreach (AutomationElement item in items)
        {
            try
            {
                System.Windows.Rect rect = item.Current.BoundingRectangle;
                if (rect.IsEmpty || double.IsInfinity(rect.Width) || rect.Width <= 0) continue;
                result.Add((item.Current.Name, rect, item));
            }
            catch (ElementNotAvailableException)
            {
                // the view changed while we were reading it
            }
        }
        return result;
    }

    /// <summary>
    /// The on-screen rectangle of the item's name (Details view: the Name cell; other views: the item).
    /// Matches the full name, or the name without extension when Explorer hides extensions and that is unique.
    /// </summary>
    public System.Windows.Rect? FindItem(string fileName, TimeSpan timeout)
    {
        var watch = Stopwatch.StartNew();
        string bare = Path.GetFileNameWithoutExtension(fileName);
        do
        {
            try
            {
                var items = Items();
                var exact = items.Where(i => string.Equals(i.name, fileName, StringComparison.OrdinalIgnoreCase)).ToList();
                var match = exact.Count == 1 ? exact : items.Where(i => string.Equals(i.name, bare, StringComparison.OrdinalIgnoreCase)).ToList();
                if (match.Count == 1) return NameCell(match[0].element, match[0].rect);
                if (match.Count > 1) Log.Info($"'{fileName}' is ambiguous in the view ({match.Count} items)");
            }
            catch (Exception error) when (error is ElementNotAvailableException or COMException or InvalidOperationException)
            {
                Log.Info($"UI Automation read failed: {error.Message}");
            }
            Thread.Sleep(300);
        } while (watch.Elapsed < timeout);
        return null;
    }

    private static System.Windows.Rect NameCell(AutomationElement item, System.Windows.Rect itemRect)
    {
        try
        {
            AutomationElement? cell = item.FindFirst(TreeScope.Children, new PropertyCondition(AutomationElement.AutomationIdProperty, "System.ItemNameDisplay"));
            if (cell != null)
            {
                System.Windows.Rect r = cell.Current.BoundingRectangle;
                if (!r.IsEmpty && r.Width > 4 && r.Height > 4) return r;
            }
        }
        catch (ElementNotAvailableException)
        {
        }
        return itemRect;
    }

    public bool IsSelected(string fileName)
    {
        foreach (var item in Items())
        {
            if (!string.Equals(item.name, fileName, StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(item.name, Path.GetFileNameWithoutExtension(fileName), StringComparison.OrdinalIgnoreCase)) continue;
            if (item.element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out object pattern)) return ((SelectionItemPattern)pattern).Current.IsSelected;
        }
        return false;
    }
}
