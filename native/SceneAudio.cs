// Reads and sets the audio volume of the process that owns a given window class.
//
// Wallpaper Engine plays a scene wallpaper's soundtrack from the process that
// renders it, so once the wallpaper is living in a pop-out window we can only
// reach its audio through CoreAudio.  This tool finds that window, resolves the
// owning process, and reads / writes its audio session.
//
//   SceneAudio.exe --list
//   SceneAudio.exe --class WPEOverlappedWallpaper --volume 40
//   SceneAudio.exe --class WPEOverlappedWallpaper --mute 1
//
// Built with the in-box C# compiler (see build.cmd), no external dependencies.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

internal static class SceneAudio
{
    // ---------------------------------------------------------------- window
    private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumProc cb, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder sb, int n);

    [DllImport("user32.dll")]
    private static extern int GetWindowThreadProcessId(IntPtr hWnd, out int pid);

    private static int PidForClass(string cls)
    {
        int found = 0;
        EnumWindows(
            delegate(IntPtr h, IntPtr l)
            {
                var sb = new StringBuilder(256);
                GetClassName(h, sb, 256);
                if (sb.ToString() != cls) return true;
                int pid;
                GetWindowThreadProcessId(h, out pid);
                found = pid;
                return false;
            },
            IntPtr.Zero);
        return found;
    }

    // ---------------------------------------------------------------- coreaudio
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionManager2
    {
        int GetAudioSessionControl(ref Guid audioSessionGuid, int streamFlags, out IntPtr sessionControl);
        int GetSimpleAudioVolume(ref Guid audioSessionGuid, int streamFlags, out IntPtr audioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [ComImport, Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
        int GetIconPath(out IntPtr path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
        int GetGroupingParam(out Guid grouping);
        int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr notify);
        int UnregisterAudioSessionNotification(IntPtr notify);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioSessionControl2
    {
        // IAudioSessionControl
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid eventContext);
        int GetIconPath(out IntPtr path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid eventContext);
        int GetGroupingParam(out Guid grouping);
        int SetGroupingParam(ref Guid grouping, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr notify);
        int UnregisterAudioSessionNotification(IntPtr notify);
        // IAudioSessionControl2
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out int pid);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool mute);
    }

    [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioMeterInformation
    {
        int GetPeakValue(out float peak);
        int GetMeteringChannelCount(out int count);
        int GetChannelsPeakValues(int count, [Out] float[] peaks);
        int QueryHardwareSupport(out int mask);
    }

    private static IEnumerable<IAudioSessionControl> Sessions()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) yield break;
        Guid iid = typeof(IAudioSessionManager2).GUID;
        object raw;
        if (device.Activate(ref iid, 1, IntPtr.Zero, out raw) != 0) yield break;
        var manager = (IAudioSessionManager2)raw;
        IAudioSessionEnumerator list;
        if (manager.GetSessionEnumerator(out list) != 0) yield break;
        int n;
        list.GetCount(out n);
        for (int i = 0; i < n; i++)
        {
            IAudioSessionControl s;
            if (list.GetSession(i, out s) == 0) yield return s;
        }
    }

    private static int Main(string[] args)
    {
        int want = -1;
        int mute = -1;
        bool list = false;
        string cls = "WPEOverlappedWallpaper";

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--list": list = true; break;
                case "--class": if (i + 1 < args.Length) cls = args[++i]; break;
                case "--volume": if (i + 1 < args.Length) int.TryParse(args[++i], out want); break;
                case "--mute": if (i + 1 < args.Length) int.TryParse(args[++i], out mute); break;
            }
        }

        int pid = PidForClass(cls);

        if (list)
        {
            foreach (var s in Sessions())
            {
                var s2 = s as IAudioSessionControl2;
                if (s2 == null) continue;
                int spid;
                if (s2.GetProcessId(out spid) != 0) continue;
                var vol = s as ISimpleAudioVolume;
                var meter = s as IAudioMeterInformation;
                float v = -1, peak = -1;
                bool m = false;
                if (vol != null) { vol.GetMasterVolume(out v); vol.GetMute(out m); }
                if (meter != null) meter.GetPeakValue(out peak);
                Console.WriteLine(string.Format("{0,6}  vol={1,5:0.00}  mute={2,-5}  peak={3,6:0.0000}{4}",
                    spid, v, m, peak, spid == pid ? "   <- pop-out" : ""));
            }
            if (pid != 0) Console.WriteLine("pop-out pid: " + pid);
            return 0;
        }

        if (pid == 0) { Console.Error.WriteLine("no window of class " + cls); return 2; }
        if (want < 0 && mute < 0) { Console.Error.WriteLine("nothing to do"); return 2; }

        int touched = 0;
        foreach (var s in Sessions())
        {
            var s2 = s as IAudioSessionControl2;
            if (s2 == null) continue;
            int spid;
            if (s2.GetProcessId(out spid) != 0 || spid != pid) continue;
            var vol = s as ISimpleAudioVolume;
            if (vol == null) continue;
            Guid ctx = Guid.Empty;
            if (want >= 0) vol.SetMasterVolume(Math.Max(0f, Math.Min(1f, want / 100f)), ref ctx);
            if (mute >= 0) vol.SetMute(mute != 0, ref ctx);
            touched++;
        }
        Console.WriteLine("pid " + pid + ": updated " + touched + " session(s)");
        return touched > 0 ? 0 : 1;
    }
}
