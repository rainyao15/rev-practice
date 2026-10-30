// Captures a Wallpaper Engine "pop-out" window and writes length-prefixed JPEG
// frames to stdout.  Built with the in-box C# compiler, no external deps.
//
//   SceneCapture.exe --width 1920 --height 1080 --fps 60 --quality 80
//                    [--pid 1234] [--class WPEOverlappedWallpaper]
//
// The window is moved off-screen and resized so that its *client area* is
// exactly width x height; the frame (title bar / borders) is cropped away, so
// every emitted frame is exactly width x height.
//
// The process declares itself per-monitor DPI aware before touching any window.
// Without that, Windows virtualises every metric: at 150% scaling a 1920x1080
// window reports as 1280x720, PrintWindow fills only the top-left 1280x720, and
// the title bar ends up inside the frame.  That was a real bug report.
//
// Wire format:  "SCENE <w> <h>\n"  then  [uint32 little-endian length][jpeg] ...
// The header is emitted exactly once; later size changes only go to stderr, so
// the frame stream stays parseable.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class SceneCapture
{
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT r);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hWnd, out RECT r);

    [DllImport("user32.dll")]
    private static extern bool ClientToScreen(IntPtr hWnd, ref POINT p);

    [DllImport("user32.dll")]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr h, int cmd);

    [DllImport("user32.dll")]
    private static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr context);

    [DllImport("shcore.dll", SetLastError = true)]
    private static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr h);

    /// <summary>
    /// Per-monitor v2 when the OS has it, per-monitor next, system-aware last.
    /// Must run before the first window/GDI call, otherwise Windows has already
    /// latched this process into DPI virtualisation.
    /// </summary>
    private static string DeclareDpiAwareness()
    {
        try
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
            if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
        }
        catch (Exception) { }
        try
        {
            // PROCESS_PER_MONITOR_DPI_AWARE
            if (SetProcessDpiAwareness(2) == 0) return "per-monitor";
        }
        catch (Exception) { }
        try
        {
            if (SetProcessDPIAware()) return "system";
        }
        catch (Exception) { }
        return "unaware";
    }

    private static double WindowScale(IntPtr hwnd)
    {
        try
        {
            uint dpi = GetDpiForWindow(hwnd);
            if (dpi > 0) return dpi / 96.0;
        }
        catch (Exception) { }
        return 1.0;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X, Y;
    }

    private static IntPtr FindWindow(int pid, string cls)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(
            delegate(IntPtr h, IntPtr l)
            {
                if (pid != 0)
                {
                    int owner;
                    GetWindowThreadProcessId(h, out owner);
                    if (owner != pid) return true;
                }
                var sb = new StringBuilder(256);
                GetClassName(h, sb, 256);
                if (sb.ToString() != cls) return true;
                RECT r;
                GetWindowRect(h, out r);
                if (r.Right - r.Left < 64) return true; // skip collapsed pop-outs
                found = h;
                return false;
            },
            IntPtr.Zero);
        return found;
    }

    private static void FixSize(IntPtr hwnd, int wantW, int wantH)
    {
        for (int i = 0; i < 3; i++)
        {
            RECT wr, cr;
            GetWindowRect(hwnd, out wr);
            GetClientRect(hwnd, out cr);
            int dw = (wr.Right - wr.Left) - (cr.Right - cr.Left);
            int dh = (wr.Bottom - wr.Top) - (cr.Bottom - cr.Top);
            SetWindowPos(hwnd, IntPtr.Zero, ParkX, ParkY,
                wantW + dw, wantH + dh, 0x0010 /*SWP_NOACTIVATE*/);
            Thread.Sleep(200);
            GetClientRect(hwnd, out cr);
            if (cr.Right - cr.Left == wantW && cr.Bottom - cr.Top == wantH) return;
        }
    }

    private const int ParkX = -4000;
    private const int ParkY = -4000;

    private static int Main(string[] args)
    {
        // first thing, before any window or GDI call
        string dpiMode = DeclareDpiAwareness();

        int pid = 0;
        string cls = "WPEOverlappedWallpaper";
        int fps = 60;
        long quality = 80;
        int wantW = 0, wantH = 0;

        for (int i = 0; i < args.Length - 1; i++)
        {
            switch (args[i])
            {
                case "--pid": int.TryParse(args[i + 1], out pid); break;
                case "--class": cls = args[i + 1]; break;
                case "--fps": int.TryParse(args[i + 1], out fps); break;
                case "--quality": long.TryParse(args[i + 1], out quality); break;
                case "--width": int.TryParse(args[i + 1], out wantW); break;
                case "--height": int.TryParse(args[i + 1], out wantH); break;
            }
        }
        if (fps < 1 || fps > 120) fps = 60;
        if (quality < 20 || quality > 100) quality = 80;

        if (Array.IndexOf(args, "--close") >= 0)
        {
            IntPtr target = FindWindow(pid, cls);
            if (target == IntPtr.Zero) { Console.Error.WriteLine("no pop-out"); return 1; }
            PostMessage(target, 0x0010 /*WM_CLOSE*/, IntPtr.Zero, IntPtr.Zero);
            return 0;
        }

        IntPtr hwnd = IntPtr.Zero;
        // Wallpaper Engine opens the pop-out at 0,0 fully visible, so look for it
        // in a tight loop first and get it out of sight as fast as we can.
        for (int i = 0; i < 6000 && hwnd == IntPtr.Zero; i++)
        {
            hwnd = FindWindow(pid, cls);
            if (hwnd == IntPtr.Zero) Thread.Sleep(i < 400 ? 5 : 50);
        }
        if (hwnd == IntPtr.Zero) { Console.Error.WriteLine("window not found"); return 3; }

        // park it far off-screen so it never shows, then size the client area
        SetWindowPos(hwnd, IntPtr.Zero, ParkX, ParkY, 0, 0, 0x0001 | 0x0010);
        // must stay *visible*: a hidden window is not composited and PrintWindow
        // then returns an all-black frame
        ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
        if (wantW > 0 && wantH > 0) FixSize(hwnd, wantW, wantH);

        // One line of diagnostics so a bug report can tell "wrong size" from
        // "wrong scaling" without guessing.
        {
            RECT wr, cr;
            GetWindowRect(hwnd, out wr);
            GetClientRect(hwnd, out cr);
            Console.Error.WriteLine(string.Format(
                "dpi {0:0.##} ({1}), window {2}x{3}, client {4}x{5}",
                WindowScale(hwnd), dpiMode,
                wr.Right - wr.Left, wr.Bottom - wr.Top,
                cr.Right - cr.Left, cr.Bottom - cr.Top));
            Console.Error.Flush();
        }

        var codec = GetEncoder(ImageFormat.Jpeg);
        var ep = new EncoderParameters(1);
        ep.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, quality);

        var stdout = Console.OpenStandardOutput();
        var len = new byte[4];

        Bitmap full = null, crop = null;
        Graphics gFull = null, gCrop = null;
        int fullW = 0, fullH = 0, cw = 0, ch = 0;
        bool headered = false;

        var frameMs = 1000.0 / fps;
        var clock = Stopwatch.StartNew();
        long sent = 0;
        long goneSince = 0;
        long lastRepair = 0;

        while (true)
        {
            if (!IsWindow(hwnd))
            {
                hwnd = FindWindow(pid, cls);
                if (hwnd == IntPtr.Zero)
                {
                    // the pop-out was closed (wallpaper switched away) — stop rather
                    // than spin forever next to a dead window
                    if (goneSince == 0) goneSince = clock.ElapsedMilliseconds;
                    else if (clock.ElapsedMilliseconds - goneSince > 10000) return 0;
                    Thread.Sleep(100);
                    continue;
                }
                goneSince = 0;
            }

            RECT wr, cr;
            GetWindowRect(hwnd, out wr);
            GetClientRect(hwnd, out cr);
            int ww = Math.Max(1, wr.Right - wr.Left);
            int wh = Math.Max(1, wr.Bottom - wr.Top);
            int nw = Math.Max(1, cr.Right - cr.Left);
            int nh = Math.Max(1, cr.Bottom - cr.Top);

            // WE minimises the pop-out whenever openWallpaper is issued again for an
            // existing window, and a minimised window has a 1x1 client area. Restore
            // it and re-apply the size instead of streaming empty frames.
            if (nw < 64 || nh < 64)
            {
                if (clock.ElapsedMilliseconds - lastRepair > 1000)
                {
                    lastRepair = clock.ElapsedMilliseconds;
                    ShowWindow(hwnd, 9); // SW_RESTORE
                    SetWindowPos(hwnd, IntPtr.Zero, ParkX, ParkY, 0, 0, 0x0001 | 0x0010);
                    if (wantW > 0 && wantH > 0) FixSize(hwnd, wantW, wantH);
                    Console.Error.WriteLine(string.Format("pop-out minimised ({0}x{1}), restored", nw, nh));
                    Console.Error.Flush();
                }
                Thread.Sleep(50);
                continue;
            }

            if (ww != fullW || wh != fullH)
            {
                if (gFull != null) gFull.Dispose();
                if (full != null) full.Dispose();
                full = new Bitmap(ww, wh, PixelFormat.Format32bppArgb);
                gFull = Graphics.FromImage(full);
                fullW = ww;
                fullH = wh;
            }
            if (nw != cw || nh != ch)
            {
                if (gCrop != null) gCrop.Dispose();
                if (crop != null) crop.Dispose();
                crop = new Bitmap(nw, nh, PixelFormat.Format32bppArgb);
                gCrop = Graphics.FromImage(crop);
                cw = nw;
                ch = nh;
                // the header is already on the wire; a new one would corrupt the
                // frame stream, so only mention the change on stderr
                if (headered)
                {
                    Console.Error.WriteLine(string.Format("client resized to {0}x{1}", cw, ch));
                    Console.Error.Flush();
                }
            }

            IntPtr hdc = gFull.GetHdc();
            bool ok;
            try { ok = PrintWindow(hwnd, hdc, 2); }
            finally { gFull.ReleaseHdc(hdc); }

            if (!ok) { Thread.Sleep(20); continue; }

            var origin = new POINT { X = 0, Y = 0 };
            ClientToScreen(hwnd, ref origin);
            int dx = origin.X - wr.Left;
            int dy = origin.Y - wr.Top;

            gCrop.DrawImage(full, new Rectangle(0, 0, cw, ch),
                new Rectangle(dx, dy, cw, ch), GraphicsUnit.Pixel);

            if (!headered)
            {
                var hh = Encoding.ASCII.GetBytes("SCENE " + cw + " " + ch + "\n");
                stdout.Write(hh, 0, hh.Length);
                stdout.Flush();
                headered = true;
            }

            using (var ms = new MemoryStream(256 * 1024))
            {
                crop.Save(ms, codec, ep);
                int n = (int)ms.Length;
                len[0] = (byte)(n & 0xFF);
                len[1] = (byte)((n >> 8) & 0xFF);
                len[2] = (byte)((n >> 16) & 0xFF);
                len[3] = (byte)((n >> 24) & 0xFF);
                stdout.Write(len, 0, 4);
                ms.Position = 0;
                ms.CopyTo(stdout);
                stdout.Flush();
                sent++;
            }

            double target = sent * frameMs;
            double now = clock.Elapsed.TotalMilliseconds;
            if (target > now) Thread.Sleep((int)Math.Min(1000, target - now));
        }
    }

    private static ImageCodecInfo GetEncoder(ImageFormat format)
    {
        foreach (var c in ImageCodecInfo.GetImageDecoders())
            if (c.FormatID == format.Guid) return c;
        return null;
    }
}
