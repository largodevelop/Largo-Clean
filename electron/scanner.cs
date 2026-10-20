// Быстрый обход диска через FindFirstFileExW: размеры приходят вместе со списком папки,
// файлы не открываются. Компилируется на лету через PowerShell Add-Type (см. scanner.js).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class LargoScanner
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WIN32_FIND_DATA
    {
        public uint dwFileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftCreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME ftLastWriteTime;
        public uint nFileSizeHigh;
        public uint nFileSizeLow;
        public uint dwReserved0;
        public uint dwReserved1;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr FindFirstFileExW(string lpFileName, int fInfoLevelId, out WIN32_FIND_DATA lpFindFileData, int fSearchOp, IntPtr lpSearchFilter, int dwAdditionalFlags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool FindNextFileW(IntPtr hFindFile, out WIN32_FIND_DATA lpFindFileData);
    [DllImport("kernel32.dll")]
    static extern bool FindClose(IntPtr hFindFile);

    const uint ATTR_DIR = 0x10, ATTR_REPARSE = 0x400, ATTR_OFFLINE = 0x1000, ATTR_RECALL_OPEN = 0x40000, ATTR_RECALL_ACCESS = 0x400000;
    const int MAX_DEPTH = 5;
    const long LEAF_MIN = 64L << 20, BIG_MIN = 256L << 20;
    static readonly IntPtr INVALID = new IntPtr(-1);

    static readonly HashSet<string> CacheNames = new HashSet<string>(new[] {
        "cache", "cache_data", "code cache", "gpucache", "dxcache", "glcache", "shadercache", "npm-cache",
        "httpcache", "htmlcache", "crashdumps", "d3dscache", "inetcache", "temp", "tmp" });
    static readonly string[] GameTails = { "\\steamapps", "\\epic games", "\\riot games", "\\xboxgames", "\\battle.net",
        "\\gog galaxy\\games", "\\ubisoft game launcher\\games", "\\ea games" };

    static string rootLower;
    static long files, bytes, denied;
    static volatile string lastDir = "";
    static readonly long[] cats = new long[7]; // games programs appdata user system temp other
    static readonly string[] CatNames = { "games", "programs", "appdata", "user", "system", "temp", "other" };
    const int GAMES = 0, PROGRAMS = 1, APPDATA = 2, USER = 3, SYSTEM = 4, TEMP = 5, OTHER = 6, UNDECIDED = -1;
    static readonly StringBuilder nodes = new StringBuilder();
    static readonly List<string> big = new List<string>();
    static readonly List<long> bigSize = new List<long>();

    static int CategoryFor(string lower, int depth, int parent)
    {
        if (parent == TEMP || parent == GAMES) return parent;
        string bname = lower.Substring(lower.LastIndexOf('\\') + 1);
        if (depth >= 2 && parent != SYSTEM && CacheNames.Contains(bname)) return TEMP;
        if (lower == rootLower + "windows\\temp" || lower.EndsWith("\\pip\\cache") || lower.EndsWith("\\nvidia\\dxcache")) return TEMP;
        foreach (var t in GameTails) if (lower.EndsWith(t)) return GAMES;
        if (depth == 1)
        {
            if (bname == "windows" || bname == "system volume information" || bname == "recovery" || bname.StartsWith("$windows.~") || bname == "windows.old" || bname == "$winreagent") return SYSTEM;
            if (bname == "program files" || bname == "program files (x86)") return PROGRAMS;
            if (bname == "programdata") return APPDATA;
            if (bname == "$recycle.bin") return TEMP;
            if (bname == "users") return UNDECIDED;
            return OTHER;
        }
        if (parent == UNDECIDED)
        {
            if (depth == 3) return (bname == "appdata" || bname.StartsWith(".")) ? APPDATA : USER;
            return UNDECIDED;
        }
        if (lower.EndsWith("\\appdata\\local\\programs")) return PROGRAMS;
        return parent;
    }

    static string Esc(string s)
    {
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
            else sb.Append(c);
        }
        return sb.ToString();
    }

    static long Ft(System.Runtime.InteropServices.ComTypes.FILETIME ft)
    {
        long v = ((long)(uint)ft.dwHighDateTime << 32) | (uint)ft.dwLowDateTime;
        return v <= 0 ? 0 : (v - 116444736000000000L) / 10000; // unix ms
    }

    static long Walk(string dir, int depth, int parentCat)
    {
        lastDir = dir;
        string lower = dir.ToLowerInvariant().TrimEnd('\\');
        int cat = depth == 0 ? OTHER : CategoryFor(lower, depth, parentCat);
        int fileCat = cat == UNDECIDED ? USER : cat;
        long total = 0, count = 0;
        var subdirs = new List<string>();
        WIN32_FIND_DATA fd;
        IntPtr h = FindFirstFileExW("\\\\?\\" + dir.TrimEnd('\\') + "\\*", 1, out fd, 0, IntPtr.Zero, 2);
        if (h == INVALID) { Interlocked.Increment(ref denied); return 0; }
        try
        {
            do
            {
                string n = fd.cFileName;
                if (n == "." || n == "..") continue;
                string full = dir.TrimEnd('\\') + "\\" + n;
                uint a = fd.dwFileAttributes;
                if ((a & ATTR_DIR) != 0)
                {
                    if ((a & ATTR_REPARSE) == 0) subdirs.Add(full); // junction'ы не обходим
                    continue;
                }
                if ((a & (ATTR_OFFLINE | ATTR_RECALL_OPEN | ATTR_RECALL_ACCESS)) != 0) continue; // облачные заглушки OneDrive
                long size = ((long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
                total += size; count++;
                int c = fileCat;
                if (depth == 0)
                {
                    string nl = n.ToLowerInvariant();
                    c = (nl == "pagefile.sys" || nl == "hiberfil.sys" || nl == "swapfile.sys" || nl == "dumpstack.log.tmp") ? SYSTEM : OTHER;
                }
                Interlocked.Add(ref cats[c], size);
                if (size >= LEAF_MIN && depth < MAX_DEPTH)
                    lock (nodes) nodes.Append("{\"p\":\"").Append(Esc(full)).Append("\",\"s\":").Append(size).Append(",\"d\":").Append(depth + 1).Append(",\"leaf\":true,\"m\":").Append(Ft(fd.ftLastWriteTime)).Append("},");
                if (size >= BIG_MIN)
                    lock (big) { big.Add("{\"p\":\"" + Esc(full) + "\",\"s\":" + size + ",\"m\":" + Ft(fd.ftLastWriteTime) + ",\"c\":\"" + CatNames[c] + "\"}"); bigSize.Add(size); }
            } while (FindNextFileW(h, out fd));
        }
        finally { FindClose(h); }
        Interlocked.Add(ref files, count);
        Interlocked.Add(ref bytes, total);

        if (depth <= 1 && subdirs.Count > 1)
        {
            long sub = 0;
            Parallel.ForEach(subdirs, new ParallelOptions { MaxDegreeOfParallelism = 8 }, d =>
            {
                long s = Walk(d, depth + 1, cat);
                Interlocked.Add(ref sub, s);
            });
            total += sub;
        }
        else
        {
            foreach (var d in subdirs) total += Walk(d, depth + 1, cat);
        }
        if (depth <= MAX_DEPTH)
            lock (nodes) nodes.Append("{\"p\":\"").Append(Esc(dir)).Append("\",\"s\":").Append(total).Append(",\"f\":").Append(count).Append(",\"d\":").Append(depth).Append("},");
        return total;
    }

    static long DirSize(string dir)
    {
        long total = 0;
        WIN32_FIND_DATA fd;
        IntPtr h = FindFirstFileExW("\\\\?\\" + dir.TrimEnd('\\') + "\\*", 1, out fd, 0, IntPtr.Zero, 2);
        if (h == INVALID) return 0;
        var subdirs = new List<string>();
        try
        {
            do
            {
                string n = fd.cFileName;
                if (n == "." || n == "..") continue;
                uint a = fd.dwFileAttributes;
                if ((a & ATTR_DIR) != 0) { if ((a & ATTR_REPARSE) == 0) subdirs.Add(dir.TrimEnd('\\') + "\\" + n); }
                else if ((a & (ATTR_OFFLINE | ATTR_RECALL_OPEN | ATTR_RECALL_ACCESS)) == 0) total += ((long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
            } while (FindNextFileW(h, out fd));
        }
        finally { FindClose(h); }
        foreach (var d in subdirs) total += DirSize(d);
        return total;
    }

    // Размеры папок из списка (по строке на путь) → JSON-массив чисел в том же порядке.
    public static void Sizes(string listFile)
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        var paths = File.ReadAllLines(listFile, Encoding.UTF8);
        var res = new long[paths.Length];
        Parallel.For(0, paths.Length, new ParallelOptions { MaxDegreeOfParallelism = 6 }, i =>
        {
            res[i] = paths[i].Length > 3 && Directory.Exists(paths[i]) ? DirSize(paths[i]) : -1;
        });
        stdout.Write("[" + string.Join(",", res) + "]");
        stdout.Flush();
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool DeleteFileW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool RemoveDirectoryW(string path);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool SetFileAttributesW(string path, uint attrs);

    class CleanStat { public long bytes, files, skipped; }

    // Содержимое dir: файлы старше cutoff (unix ms) считаются, при dry=false удаляются. Пустые подпапки убираются, сама dir — нет.
    static bool CleanDir(string dir, long cutoff, bool dry, CleanStat st, string id, StreamWriter outw, bool isRoot)
    {
        WIN32_FIND_DATA fd;
        string baseDir = "\\\\?\\" + dir.TrimEnd('\\');
        IntPtr h = FindFirstFileExW(baseDir + "\\*", 1, out fd, 0, IntPtr.Zero, 2);
        if (h == INVALID) return false;
        var subdirs = new List<string>();
        bool empty = true;
        try
        {
            do
            {
                string n = fd.cFileName;
                if (n == "." || n == "..") continue;
                uint a = fd.dwFileAttributes;
                if ((a & ATTR_DIR) != 0)
                {
                    if ((a & ATTR_REPARSE) == 0) subdirs.Add(dir.TrimEnd('\\') + "\\" + n);
                    else empty = false;
                    continue;
                }
                long t = Math.Max(Ft(fd.ftLastWriteTime), Ft(fd.ftCreationTime));
                if (t > cutoff || (a & (ATTR_OFFLINE | ATTR_RECALL_OPEN | ATTR_RECALL_ACCESS)) != 0) { empty = false; continue; }
                long size = ((long)fd.nFileSizeHigh << 32) | fd.nFileSizeLow;
                if (dry) { st.bytes += size; st.files++; empty = false; continue; }
                string fp = baseDir + "\\" + n;
                if ((a & 0x1) != 0) SetFileAttributesW(fp, 0x80); // снять «только чтение»
                if (DeleteFileW(fp))
                {
                    st.bytes += size; st.files++;
                    if ((st.files & 511) == 0) lock (outw) outw.WriteLine("P\t" + id + "\t" + st.files + "\t" + st.bytes);
                }
                else { st.skipped++; empty = false; }
            } while (FindNextFileW(h, out fd));
        }
        finally { FindClose(h); }
        foreach (var d in subdirs)
        {
            bool subEmpty = CleanDir(d, cutoff, dry, st, id, outw, false);
            if (dry || !subEmpty || !RemoveDirectoryW("\\\\?\\" + d)) empty = false;
        }
        return empty;
    }

    // Строки списка: "<id>\t<minAgeMs>\t<путь>". Вывод: "P\t<id>\t<files>\t<bytes>" и "R\t{id:{bytes,files,skipped}}".
    public static void Clean(string listFile, bool dry)
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        var byId = new Dictionary<string, CleanStat>();
        var jobs = new List<Tuple<string, long, string>>();
        long now = (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
        foreach (var line in File.ReadAllLines(listFile, Encoding.UTF8))
        {
            var parts = line.Split('\t');
            if (parts.Length != 3 || parts[2].Length < 4) continue;
            if (!byId.ContainsKey(parts[0])) byId[parts[0]] = new CleanStat();
            jobs.Add(Tuple.Create(parts[0], now - long.Parse(parts[1]), parts[2]));
        }
        Parallel.ForEach(jobs, new ParallelOptions { MaxDegreeOfParallelism = 6 }, j =>
        {
            var local = new CleanStat();
            if (Directory.Exists(j.Item3)) CleanDir(j.Item3, j.Item2, dry, local, j.Item1, stdout, true);
            var st = byId[j.Item1];
            lock (st) { st.bytes += local.bytes; st.files += local.files; st.skipped += local.skipped; }
        });
        var sb = new StringBuilder("{");
        bool first = true;
        foreach (var kv in byId)
        {
            sb.Append(first ? "" : ",").Append('"').Append(Esc(kv.Key)).Append("\":{\"bytes\":").Append(kv.Value.bytes)
              .Append(",\"files\":").Append(kv.Value.files).Append(",\"skipped\":").Append(kv.Value.skipped).Append('}');
            first = false;
        }
        stdout.WriteLine("R\t" + sb.Append('}'));
    }

    // Пишет строки прогресса "P\t<files>\t<bytes>\t<dir>" и в конце одну строку "R\t<json>".
    public static void Run(string root)
    {
        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        stdout.AutoFlush = true;
        rootLower = root.ToLowerInvariant();
        var sw = System.Diagnostics.Stopwatch.StartNew();
        var done = new ManualResetEvent(false);
        var ticker = new Thread(() =>
        {
            while (!done.WaitOne(250))
                lock (stdout) stdout.WriteLine("P\t" + Interlocked.Read(ref files) + "\t" + Interlocked.Read(ref bytes) + "\t" + lastDir);
        });
        ticker.IsBackground = true;
        ticker.Start();
        Walk(root, 0, OTHER);
        done.Set();

        var order = new List<int>();
        for (int i = 0; i < big.Count; i++) order.Add(i);
        order.Sort((x, y) => bigSize[y].CompareTo(bigSize[x]));
        var sb = new StringBuilder();
        sb.Append("{\"root\":\"").Append(Esc(root)).Append("\",\"files\":").Append(files).Append(",\"bytes\":").Append(bytes)
          .Append(",\"denied\":").Append(denied).Append(",\"ms\":").Append(sw.ElapsedMilliseconds).Append(",\"cats\":{");
        for (int i = 0; i < 7; i++) sb.Append(i > 0 ? "," : "").Append('"').Append(CatNames[i]).Append("\":").Append(cats[i]);
        sb.Append("},\"bigFiles\":[");
        for (int i = 0; i < order.Count && i < 40; i++) sb.Append(i > 0 ? "," : "").Append(big[order[i]]);
        sb.Append("],\"nodes\":[");
        if (nodes.Length > 0) nodes.Length--; // хвостовая запятая
        sb.Append(nodes).Append("]}");
        lock (stdout) stdout.WriteLine("R\t" + sb.ToString());
    }
}
