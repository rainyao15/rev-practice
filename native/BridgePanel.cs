// BridgePanel.exe — tray shell for the Wallpaper Engine ↔ NetEase Cloud Music bridge.
//
// It owns no UI of its own: the control panel is the HTML page served by the
// bridge (src/panel-state.mjs), shown in an Edge "app" window. This process only
// provides the things a web page cannot: a tray icon, a single instance, and the
// ability to start/stop the bridge underneath.
//
// Built with the in-box compiler (C# 5), so: no string interpolation, no
// expression-bodied members, no pattern matching. compile with native\build.cmd.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace CloudMusicWallpaper
{
    static class Program
    {
        public const string PanelUrl = "http://127.0.0.1:2011/";
        public const string AppTitle = "网易云背景";

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        static Mutex mutex;

        [STAThread]
        static void Main(string[] args)
        {
            bool created;
            mutex = new Mutex(true, "Global\\cloudmusic-wallpaper-bridge-shell", out created);
            if (!created)
            {
                // already running: bring the panel forward instead of starting a second copy
                ShowExistingPanel();
                return;
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new TrayContext());
        }

        public static string AppDir()
        {
            return Path.GetDirectoryName(Application.ExecutablePath);
        }

        public static string NodeExe()
        {
            string fromPath = FindOnPath("node.exe");
            if (fromPath != null) return fromPath;
            string guess = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs\\node.exe");
            if (File.Exists(guess)) return guess;
            return null;
        }

        static string FindOnPath(string exe)
        {
            string path = Environment.GetEnvironmentVariable("PATH") ?? "";
            string[] parts = path.Split(';');
            for (int i = 0; i < parts.Length; i++)
            {
                if (parts[i].Trim().Length == 0) continue;
                try
                {
                    string candidate = Path.Combine(parts[i].Trim(), exe);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { }
            }
            return null;
        }

        public static string EdgeExe()
        {
            string[] candidates = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                    "Microsoft\\Edge\\Application\\msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    "Microsoft\\Edge\\Application\\msedge.exe"),
            };
            for (int i = 0; i < candidates.Length; i++)
            {
                if (File.Exists(candidates[i])) return candidates[i];
            }
            return null;
        }

        // ---------------------------------------------------------------- bridge

        public static bool BridgeAlive()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PanelUrl + "state");
                req.Timeout = 1200;
                req.ReadWriteTimeout = 1200;
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                {
                    return (int)res.StatusCode == 200;
                }
            }
            catch { return false; }
        }

        public static void StartBridge()
        {
            if (BridgeAlive()) return;
            string node = NodeExe();
            if (node == null) return;
            ProcessStartInfo psi = new ProcessStartInfo(node, "src\\main.mjs");
            psi.WorkingDirectory = AppDir();
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.WindowStyle = ProcessWindowStyle.Hidden;
            try { Process.Start(psi); } catch { }
        }

        public static string PostAction(string json)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PanelUrl + "action");
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                req.Timeout = 30000;
                req.ReadWriteTimeout = 30000;
                byte[] body = Encoding.UTF8.GetBytes(json);
                req.ContentLength = body.Length;
                using (Stream s = req.GetRequestStream()) { s.Write(body, 0, body.Length); }
                using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                {
                    return sr.ReadToEnd();
                }
            }
            catch (Exception e)
            {
                return "{\"ok\":false,\"error\":\"" + e.Message.Replace("\"", "'") + "\"}";
            }
        }

        public static void ShowPanel()
        {
            StartBridge();
            string edge = EdgeExe();
            if (edge == null)
            {
                MessageBox.Show("找不到 Microsoft Edge，面板需要它来显示。", AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            string profile = Path.Combine(AppDir(), "runtime\\edge-profile");
            ProcessStartInfo psi = new ProcessStartInfo(edge);
            psi.Arguments = "--app=" + PanelUrl + " --user-data-dir=\"" + profile +
                "\" --window-size=420,600 --no-first-run";
            try { Process.Start(psi); } catch { }
        }

        static void ShowExistingPanel()
        {
            Process[] procs = Process.GetProcessesByName("msedge");
            for (int i = 0; i < procs.Length; i++)
            {
                try
                {
                    if (procs[i].MainWindowTitle == AppTitle)
                    {
                        ShowWindow(procs[i].MainWindowHandle, 9);
                        SetForegroundWindow(procs[i].MainWindowHandle);
                        return;
                    }
                }
                catch { }
            }
            ShowPanel();
        }
    }

    sealed class TrayContext : ApplicationContext
    {
        readonly NotifyIcon tray;
        readonly ToolStripMenuItem pauseItem;
        readonly ToolStripMenuItem resumeItem;
        System.Windows.Forms.Timer health;

        public TrayContext()
        {
            pauseItem = new ToolStripMenuItem("暂停（网易云恢复原背景）", null, delegate { Act("pause"); });
            resumeItem = new ToolStripMenuItem("启用", null, delegate { Act("resume"); });
            ToolStripMenuItem open = new ToolStripMenuItem("打开控制面板", null, delegate { Program.ShowPanel(); });
            ToolStripMenuItem log = new ToolStripMenuItem("打开日志", null, delegate { Act("log"); });
            ToolStripMenuItem restore = new ToolStripMenuItem("彻底还原（移除所有壁纸的属性组）", null, delegate { Restore(); });
            ToolStripMenuItem quit = new ToolStripMenuItem("退出托盘", null, delegate { ExitShell(); });

            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(pauseItem);
            menu.Items.Add(resumeItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(log);
            menu.Items.Add(restore);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(quit);

            tray = new NotifyIcon();
            tray.Icon = BuildIcon();
            tray.Text = "网易云背景桥接";
            tray.ContextMenuStrip = menu;
            tray.Visible = true;
            tray.DoubleClick += delegate { Program.ShowPanel(); };

            Program.StartBridge();

            // first run should show something — afterwards the tray icon is enough
            Program.ShowPanel();

            health = new System.Windows.Forms.Timer();
            health.Interval = 3000;
            health.Tick += delegate { RefreshState(); };
            health.Start();
            RefreshState();
        }

        static Icon BuildIcon()
        {
            // a 32x32 rounded square with a red play mark, so the tray needs no asset
            Bitmap bmp = new Bitmap(32, 32);
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                using (Brush bg = new SolidBrush(Color.FromArgb(210, 24, 24, 30)))
                {
                    g.FillEllipse(bg, 1, 1, 30, 30);
                }
                using (Brush red = new SolidBrush(Color.FromArgb(230, 205, 45, 45)))
                {
                    g.FillEllipse(red, 4, 4, 24, 24);
                }
                Point[] tri = new Point[] { new Point(13, 10), new Point(24, 16), new Point(13, 22) };
                g.FillPolygon(Brushes.White, tri);
            }
            return Icon.FromHandle(bmp.GetHicon());
        }

        void Act(string action)
        {
            string payload = "{\"action\":\"" + action + "\"}";
            string res = Program.PostAction(payload);
            if (action == "log" && res.IndexOf("\"opened\":true") < 0)
            {
                MessageBox.Show("打开日志失败：\n" + res, Program.AppTitle,
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            RefreshState();
        }

        void Restore()
        {
            DialogResult a = MessageBox.Show(
                "会从所有壁纸的 project.json 里移除「网易云背景」属性组。\n" +
                "之后需要重启 Wallpaper Engine，面板里那一组才会消失。\n\n确定吗？",
                Program.AppTitle, MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
            if (a != DialogResult.Yes) return;

            string res = Program.PostAction("{\"action\":\"restore\",\"confirm\":true}");
            MessageBox.Show(res, Program.AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Information);
            RefreshState();
        }

        void RefreshState()
        {
            bool alive = Program.BridgeAlive();
            pauseItem.Enabled = alive;
            resumeItem.Enabled = alive;
            tray.Text = alive ? "网易云背景桥接 · 运行中" : "网易云背景桥接 · 未运行";
        }

        void ExitShell()
        {
            DialogResult a = MessageBox.Show(
                "退出托盘只会关掉这个图标，桥接和后台窗口继续运行。\n\n要同时停止桥接吗？",
                Program.AppTitle, MessageBoxButtons.YesNoCancel, MessageBoxIcon.Question);
            if (a == DialogResult.Cancel) return;
            if (a == DialogResult.Yes)
            {
                // the bridge may be elevated; autostart.cmd knows how to ask for that
                try
                {
                    ProcessStartInfo psi = new ProcessStartInfo(
                        Path.Combine(Program.AppDir(), "autostart.cmd"), "stop");
                    psi.WorkingDirectory = Program.AppDir();
                    psi.UseShellExecute = true;
                    psi.WindowStyle = ProcessWindowStyle.Hidden;
                    Process.Start(psi);
                }
                catch { }
            }
            tray.Visible = false;
            health.Stop();
            ExitThread();
        }
    }
}
