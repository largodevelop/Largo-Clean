// largo-sensors: датчики и вентиляторы для Largo Clean на LibreHardwareMonitorLib.
// stdout: одна JSON-строка в секунду {"type":"sample",...}. stdin: JSON-команды по строке.
// Безопасность вентиляторов: минимум 20 % в ручном режиме и по кривой, при 90 °C на любом
// датчике CPU/GPU все управляемые вентиляторы → 100 %, при выходе (в т.ч. смерти родителя) —
// управление возвращается BIOS / драйверу (SetDefault).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using LibreHardwareMonitor.Hardware;

static class Program
{
    const float MinPct = 20f;
    const float PanicTemp = 90f;

    class FanRule
    {
        public string Mode = "auto"; // auto | manual | curve
        public float Pct = 50;
        public string Sensor;
        public List<float[]> Curve = new List<float[]>();
        public float Applied = -1;
        public bool Owned; // мы выставляли скорость — при «авто» и выходе вернуть управление BIOS/драйверу
    }

    static Computer computer;
    static readonly Dictionary<string, ISensor> controls = new Dictionary<string, ISensor>();
    static readonly Dictionary<string, FanRule> rules = new Dictionary<string, FanRule>();
    static readonly object gate = new object();
    static volatile bool running = true;
    static readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
    static StreamWriter stdout;

    static int Main(string[] args)
    {
        stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        int parentPid = 0;
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--parent") int.TryParse(args[i + 1], out parentPid);

        AppDomain.CurrentDomain.ProcessExit += (s, e) => RestoreAll();
        Console.CancelKeyPress += (s, e) => { running = false; e.Cancel = true; };

        computer = new Computer
        {
            IsCpuEnabled = true, IsGpuEnabled = true, IsMemoryEnabled = true, IsMotherboardEnabled = true,
            IsControllerEnabled = true, IsStorageEnabled = true, IsNetworkEnabled = true,
        };
        try { computer.Open(); }
        catch (Exception ex) { Emit(new Dictionary<string, object> { { "type", "error" }, { "error", ex.Message } }); }

        new Thread(ReadCommands) { IsBackground = true }.Start();
        if (parentPid > 0) new Thread(() => WatchParent(parentPid)) { IsBackground = true }.Start();

        while (running)
        {
            var started = DateTime.UtcNow;
            try { Tick(); }
            catch (Exception ex) { Emit(new Dictionary<string, object> { { "type", "error" }, { "error", ex.Message } }); }
            var left = 1000 - (int)(DateTime.UtcNow - started).TotalMilliseconds;
            if (left > 0) Thread.Sleep(left);
        }
        RestoreAll();
        try { computer.Close(); } catch { }
        return 0;
    }

    static void WatchParent(int pid)
    {
        try { Process.GetProcessById(pid).WaitForExit(); } catch { }
        running = false;
        RestoreAll();
        Environment.Exit(0);
    }

    static void ReadCommands()
    {
        string line;
        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        while ((line = stdin.ReadLine()) != null)
        {
            try { Handle(json.Deserialize<Dictionary<string, object>>(line)); }
            catch (Exception ex) { Emit(new Dictionary<string, object> { { "type", "error" }, { "error", "команда: " + ex.Message } }); }
        }
        running = false; // stdin закрыт — родитель ушёл
    }

    static void Handle(Dictionary<string, object> cmd)
    {
        var name = cmd.ContainsKey("cmd") ? (string)cmd["cmd"] : "";
        if (name == "quit") { running = false; return; }
        if (name != "fan") return;
        var id = (string)cmd["id"];
        lock (gate)
        {
            if (!rules.TryGetValue(id, out var rule)) rules[id] = rule = new FanRule();
            rule.Mode = cmd.ContainsKey("mode") ? (string)cmd["mode"] : "auto";
            if (cmd.ContainsKey("pct")) rule.Pct = Convert.ToSingle(cmd["pct"]);
            if (cmd.ContainsKey("sensor")) rule.Sensor = (string)cmd["sensor"];
            if (cmd.ContainsKey("curve") && cmd["curve"] is System.Collections.ArrayList pts)
            {
                rule.Curve = pts.Cast<System.Collections.ArrayList>()
                    .Select(p => new[] { Convert.ToSingle(p[0]), Convert.ToSingle(p[1]) })
                    .OrderBy(p => p[0]).ToList();
            }
            rule.Applied = -1;
        }
    }

    static IEnumerable<IHardware> AllHardware()
    {
        foreach (var hw in computer.Hardware)
        {
            yield return hw;
            foreach (var sub in hw.SubHardware) yield return sub;
        }
    }

    static float CurveValue(List<float[]> curve, float t)
    {
        if (curve.Count == 0) return 100;
        if (t <= curve[0][0]) return curve[0][1];
        for (int i = 1; i < curve.Count; i++)
        {
            if (t <= curve[i][0])
            {
                var a = curve[i - 1]; var b = curve[i];
                return a[1] + (b[1] - a[1]) * (t - a[0]) / Math.Max(0.001f, b[0] - a[0]);
            }
        }
        return curve[curve.Count - 1][1];
    }

    static void Tick()
    {
        var sensorsById = new Dictionary<string, ISensor>();
        var hwList = new List<object>();
        float hottest = 0;

        foreach (var hw in AllHardware())
        {
            hw.Update();
            var sensors = new List<object>();
            foreach (var s in hw.Sensors)
            {
                var id = s.Identifier.ToString();
                sensorsById[id] = s;
                if (s.SensorType == SensorType.Control && s.Control != null) controls[id] = s;
                if (s.SensorType == SensorType.Temperature && s.Value.HasValue &&
                    (hw.HardwareType == HardwareType.Cpu || hw.HardwareType == HardwareType.GpuNvidia || hw.HardwareType == HardwareType.GpuAmd || hw.HardwareType == HardwareType.GpuIntel))
                    hottest = Math.Max(hottest, s.Value.Value);
                sensors.Add(new Dictionary<string, object>
                {
                    { "id", id }, { "name", s.Name }, { "type", s.SensorType.ToString() },
                    { "value", s.Value }, { "min", s.Min }, { "max", s.Max },
                });
            }
            hwList.Add(new Dictionary<string, object>
            {
                { "id", hw.Identifier.ToString() }, { "name", hw.Name }, { "type", hw.HardwareType.ToString() },
                { "parent", hw.Parent?.Identifier.ToString() }, { "sensors", sensors },
            });
        }

        // Вентиляторы: обороты /…/fan/N в паре с управлением /…/control/N той же микросхемы
        var fans = new List<object>();
        lock (gate)
        {
            foreach (var kv in controls)
            {
                var ctl = kv.Value;
                var rpmId = kv.Key.Replace("/control/", "/fan/");
                sensorsById.TryGetValue(rpmId, out var rpm);
                rules.TryGetValue(kv.Key, out var rule);
                var mode = rule?.Mode ?? "auto";

                float target = -1;
                if (mode == "manual") target = Math.Max(MinPct, Math.Min(100, rule.Pct));
                else if (mode == "curve")
                {
                    float t = rule.Sensor != null && sensorsById.TryGetValue(rule.Sensor, out var src) && src.Value.HasValue ? src.Value.Value : hottest;
                    target = Math.Max(MinPct, Math.Min(100, CurveValue(rule.Curve, t)));
                }
                if (target >= 0 && hottest >= PanicTemp) target = 100;

                try
                {
                    if (target >= 0)
                    {
                        if (Math.Abs(target - rule.Applied) >= 1) { ctl.Control.SetSoftware(target); rule.Applied = target; rule.Owned = true; }
                    }
                    else if (rule != null && rule.Owned) { ctl.Control.SetDefault(); rule.Applied = -1; rule.Owned = false; }
                }
                catch (Exception ex) { Emit(new Dictionary<string, object> { { "type", "error" }, { "error", ctl.Name + ": " + ex.Message } }); }

                fans.Add(new Dictionary<string, object>
                {
                    { "id", kv.Key }, { "name", rpm?.Name ?? ctl.Name }, { "hardware", ctl.Hardware.Name },
                    { "rpm", rpm?.Value }, { "pct", ctl.Value }, { "mode", mode }, { "target", target >= 0 ? (object)target : null },
                    { "min", ctl.Control.MinSoftwareValue }, { "max", ctl.Control.MaxSoftwareValue },
                });
            }
        }

        Emit(new Dictionary<string, object>
        {
            { "type", "sample" }, { "t", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() },
            { "admin", new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator) },
            { "hottest", hottest }, { "panic", hottest >= PanicTemp }, { "hardware", hwList }, { "fans", fans },
        });
    }

    static int restored;
    static void RestoreAll()
    {
        if (Interlocked.Exchange(ref restored, 1) == 1) return;
        lock (gate)
        {
            foreach (var kv in controls)
            {
                if (!rules.TryGetValue(kv.Key, out var r) || !r.Owned) continue;
                try { kv.Value.Control.SetDefault(); } catch { }
            }
        }
    }

    static void Emit(Dictionary<string, object> obj)
    {
        var line = json.Serialize(obj);
        lock (stdout) stdout.WriteLine(line);
    }
}
