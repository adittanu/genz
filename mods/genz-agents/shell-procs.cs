// What each shell is running right now, for the Terminals list in genz-agents.
// Usage: shell-procs.exe <shell pid> [<shell pid> ...]
// Prints one line per shell that has a command running, tab separated:
//   <shell pid> \t <command's start, ms since 1970> \t <processes under the shell> \t <exe name> \t <command line>
// A shell waiting at its prompt prints nothing.
// Why: on Windows the core reports the shell itself as a terminal's foreground program, whatever runs in it,
// so the command is read from the process table: the shell's newest direct child.
// Compiled once by the mod (csc, .NET Framework) so a look costs ~50 ms instead of a pwsh start (~500 ms).
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class ShellProcs
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W e);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W e);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr buf, int len, out int needed);

    const uint QUERY_LIMITED = 0x1000;
    const int COMMAND_LINE = 60;

    class Proc
    {
        public uint Pid;
        public uint Parent;
        public string Exe;
    }

    public static int Main(string[] args)
    {
        try { return Run(args); } catch { return 1; }
    }

    static int Run(string[] args)
    {
        var kids = new Dictionary<uint, List<Proc>>();
        IntPtr snap = CreateToolhelp32Snapshot(2, 0);
        if (snap == new IntPtr(-1)) return 1;
        var e = new PROCESSENTRY32W();
        e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
        if (Process32FirstW(snap, ref e))
        {
            do
            {
                var p = new Proc();
                p.Pid = e.th32ProcessID;
                p.Parent = e.th32ParentProcessID;
                p.Exe = e.szExeFile;
                List<Proc> l;
                if (!kids.TryGetValue(p.Parent, out l)) { l = new List<Proc>(); kids[p.Parent] = l; }
                l.Add(p);
            } while (Process32NextW(snap, ref e));
        }
        CloseHandle(snap);

        var sb = new StringBuilder();
        foreach (string a in args)
        {
            uint shell;
            if (!uint.TryParse(a, out shell) || shell == 0) continue;
            long born = Created(shell);
            if (born == 0) continue;
            // The shell's direct children that started after it (a reused pid can name a dead parent); the newest is the command.
            Proc top = null;
            long topAt = 0;
            int count = 0;
            var queue = new Queue<KeyValuePair<Proc, long>>();
            Collect(kids, shell, born, queue);
            bool first = true;
            int direct = queue.Count;
            while (queue.Count > 0 && count < 500)
            {
                var kv = queue.Dequeue();
                count++;
                if (direct > 0)
                {
                    direct--;
                    if (first || kv.Value >= topAt) { top = kv.Key; topAt = kv.Value; first = false; }
                }
                Collect(kids, kv.Key.Pid, kv.Value, queue);
            }
            if (top == null) continue;
            string line = Clean(CommandLine(top.Pid));
            long ms = (topAt - 116444736000000000L) / 10000L;
            sb.Append(shell).Append('\t').Append(ms).Append('\t').Append(count).Append('\t')
              .Append(Clean(top.Exe)).Append('\t').Append(line).Append('\n');
        }
        var o = Console.OpenStandardOutput();
        byte[] bytes = new UTF8Encoding(false).GetBytes(sb.ToString());
        o.Write(bytes, 0, bytes.Length);
        o.Flush();
        return 0;
    }

    static void Collect(Dictionary<uint, List<Proc>> kids, uint parent, long parentBorn, Queue<KeyValuePair<Proc, long>> into)
    {
        List<Proc> l;
        if (!kids.TryGetValue(parent, out l)) return;
        foreach (Proc p in l)
        {
            if (p.Pid == 0 || p.Pid == parent) continue;
            long at = Created(p.Pid);
            // Unreadable (another user's, or gone already): not ours to show.
            if (at == 0 || at < parentBorn) continue;
            into.Enqueue(new KeyValuePair<Proc, long>(p, at));
        }
    }

    static long Created(uint pid)
    {
        IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return 0;
        long c, x, k, u;
        bool ok = GetProcessTimes(h, out c, out x, out k, out u);
        CloseHandle(h);
        return ok ? c : 0;
    }

    static string CommandLine(uint pid)
    {
        IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
        if (h == IntPtr.Zero) return "";
        try
        {
            int size = 2048;
            for (int i = 0; i < 3; i++)
            {
                IntPtr buf = Marshal.AllocHGlobal(size);
                try
                {
                    int needed;
                    int st = NtQueryInformationProcess(h, COMMAND_LINE, buf, size, out needed);
                    if (st == 0)
                    {
                        // UNICODE_STRING: Length (bytes), MaximumLength, then the pointer (aligned).
                        int len = (ushort)Marshal.ReadInt16(buf);
                        IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size);
                        return text == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text, len / 2);
                    }
                    if (needed <= size) return "";
                    size = needed + 64;
                }
                finally { Marshal.FreeHGlobal(buf); }
            }
            return "";
        }
        catch { return ""; }
        finally { CloseHandle(h); }
    }

    static string Clean(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder(s.Length);
        foreach (char c in s) sb.Append(c < ' ' ? ' ' : c);
        string r = sb.ToString().Trim();
        return r.Length > 600 ? r.Substring(0, 600) : r;
    }
}
