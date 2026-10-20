"use strict";

// Установленные программы и игры Steam + когда их последний раз запускали.
// Источники запусков: UserAssist (история запусков из Проводника/Пуска), Prefetch (нужны права админа), Steam LastPlayed.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { runPs, runPsJson } = require("./ps");
const { sourcePath } = require("./scanner");

const REGISTRY_PS = String.raw`
$keys = @(
  @{ hive='HKLM'; path='HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' },
  @{ hive='HKLM32'; path='HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*' },
  @{ hive='HKCU'; path='HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' }
)
$apps = foreach ($k in $keys) {
  Get-ItemProperty $k.path | Where-Object { $_.DisplayName -and $_.SystemComponent -ne 1 -and -not $_.ParentKeyName -and $_.ReleaseType -notmatch 'Update|Hotfix' } | ForEach-Object {
    [pscustomobject]@{
      key = $k.hive + '\' + $_.PSChildName; name = [string]$_.DisplayName; publisher = [string]$_.Publisher; version = [string]$_.DisplayVersion
      installDate = [string]$_.InstallDate; location = [string]$_.InstallLocation; icon = [string]$_.DisplayIcon
      size = [int64]$_.EstimatedSize * 1024; uninstall = [string]$_.UninstallString
    }
  }
}
$ua = foreach ($g in Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\UserAssist') {
  $item = Get-Item (Join-Path $g.PSPath 'Count')
  foreach ($n in $item.GetValueNames()) {
    $v = $item.GetValue($n)
    if ($v -is [byte[]] -and $v.Length -ge 68) {
      $ft = [BitConverter]::ToInt64($v, 60)
      if ($ft -gt 0) { [pscustomobject]@{ n = $n; c = [BitConverter]::ToInt32($v, 4); t = [DateTimeOffset]::FromFileTime($ft).ToUnixTimeMilliseconds() } }
    }
  }
}
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$bk = Get-Item ('HKLM:\SYSTEM\CurrentControlSet\Services\bam\State\UserSettings\' + $sid)
$bam = foreach ($n in $bk.GetValueNames()) {
  $v = $bk.GetValue($n)
  if ($n -like '\Device\*' -and $v -is [byte[]] -and $v.Length -ge 8) { [pscustomobject]@{ n = $n; t = [DateTimeOffset]::FromFileTime([BitConverter]::ToInt64($v, 0)).ToUnixTimeMilliseconds() } }
}
@{ apps = @($apps); ua = @($ua); bam = @($bam) } | ConvertTo-Json -Depth 3 -Compress
`;

// Папки, заданные GUID'ами в UserAssist.
const KNOWN_FOLDERS = {
  "{6D809377-6AF0-444B-8957-A3773F02200E}": process.env.ProgramW6432 || "C:\\Program Files",
  "{7C5A40EF-A0FB-4BFC-874A-C0F2E0B9FA8E}": process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
  "{F38BF404-1D43-42F2-9305-67DE0B28FC23}": process.env.SystemRoot || "C:\\Windows",
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}": path.join(process.env.SystemRoot || "C:\\Windows", "System32"),
  "{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}": path.join(process.env.SystemRoot || "C:\\Windows", "SysWOW64"),
  "{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}": path.join(process.env.ProgramData || "C:\\ProgramData", "Microsoft", "Windows", "Start Menu", "Programs"),
  "{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}": path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs"),
  "{9E3995AB-1F9C-4F13-B827-48B24B6C7174}": path.join(process.env.APPDATA || "", "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned"),
  "{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}": path.join(os.homedir(), "Desktop"),
  "{374DE290-123F-4565-9164-39C4925E467B}": path.join(os.homedir(), "Downloads"),
  "{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}": process.env.LOCALAPPDATA || "",
};

function rot13(s) {
  return s.replace(/[a-zA-Z]/g, (c) => {
    const b = c <= "Z" ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - b + 13) % 26) + b);
  });
}

function resolveUaPath(raw) {
  let p = rot13(raw);
  const m = p.match(/^(\{[0-9A-F-]{36}\})(.*)$/i);
  if (m) {
    const base = KNOWN_FOLDERS[m[1].toUpperCase()];
    if (!base) return null;
    p = base + m[2];
  }
  return /^[a-z]:\\/i.test(p) ? p : null;
}

// Лёгкий парсер VDF (формат Steam): "ключ" "значение" и "ключ" { ... }
function parseVdf(text) {
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g;
  const root = {};
  const stack = [root];
  let key = null;
  let m;
  while ((m = re.exec(text))) {
    const cur = stack[stack.length - 1];
    if (m[2] === "{") {
      const obj = {};
      if (key !== null) cur[key] = obj;
      stack.push(obj);
      key = null;
    } else if (m[2] === "}") {
      stack.pop();
      key = null;
    } else {
      const s = m[1].replace(/\\\\/g, "\\").replace(/\\"/g, '"');
      if (key === null) key = s;
      else {
        cur[key] = s;
        key = null;
      }
    }
  }
  return root;
}

async function steamGames() {
  let steam = null;
  try {
    steam = (await runPs("(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath")).trim();
  } catch (_) {}
  if (!steam) return [];
  steam = path.normalize(steam);
  let libs = [steam];
  try {
    const vdf = parseVdf(fs.readFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"), "utf8"));
    const lf = vdf.libraryfolders || {};
    libs = Object.values(lf).map((v) => v && v.path).filter(Boolean).map((p) => path.normalize(p));
  } catch (_) {}
  const games = [];
  for (const lib of libs) {
    const dir = path.join(lib, "steamapps");
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^appmanifest_\d+\.acf$/.test(n));
    } catch (_) {
      continue;
    }
    for (const n of names) {
      try {
        const st = parseVdf(fs.readFileSync(path.join(dir, n), "utf8")).AppState;
        if (!st || st.appid === "228980") continue; // Steamworks Common Redistributables
        const location = path.join(dir, "common", st.installdir || "");
        games.push({
          id: "steam:" + st.appid,
          kind: "steam",
          appid: st.appid,
          name: st.name || "Steam App " + st.appid,
          publisher: "Steam",
          location,
          size: Number(st.SizeOnDisk) || 0,
          lastUsed: Number(st.LastPlayed) > 0 ? Number(st.LastPlayed) * 1000 : 0,
          neverUsed: !(Number(st.LastPlayed) > 0),
          usageSource: "steam",
          installDate: 0,
          iconFile: steamIcon(steam, st.appid),
        });
      }
      catch (_) {}
    }
  }
  return games;
}

function steamIcon(steam, appid) {
  const dir = path.join(steam, "appcache", "librarycache", String(appid));
  try {
    const names = fs.readdirSync(dir);
    const icon = names.find((n) => /^[0-9a-f]{40}\.jpg$/i.test(n));
    if (icon) return path.join(dir, icon);
    if (names.includes("logo.png")) return path.join(dir, "logo.png");
  } catch (_) {}
  const old = path.join(steam, "appcache", "librarycache", appid + "_icon.jpg");
  return fs.existsSync(old) ? old : null;
}

function prefetchTimes() {
  const map = new Map();
  try {
    const dir = path.join(process.env.SystemRoot || "C:\\Windows", "Prefetch");
    for (const n of fs.readdirSync(dir)) {
      const m = n.match(/^(.+\.EXE)-[0-9A-F]{8}\.pf$/i);
      if (!m) continue;
      const t = fs.statSync(path.join(dir, n)).mtimeMs;
      const exe = m[1].toLowerCase();
      if ((map.get(exe) || 0) < t) map.set(exe, t);
    }
  } catch (_) {}
  return map;
}

function exeFromIcon(icon) {
  if (!icon) return null;
  const p = icon.replace(/^"|"?,\s*-?\d+$|"$/g, "").trim();
  return /\.(exe|ico)$/i.test(p) ? p : null;
}

// Папка программы годится для сопоставления запусков, только если она конкретная (не C:\Program Files и не C:\Windows).
const GENERIC = new Set(
  [
    process.env.ProgramW6432, process.env["ProgramFiles(x86)"], process.env.ProgramFiles, process.env.SystemRoot,
    path.join(process.env.SystemRoot || "C:\\Windows", "System32"), path.join(process.env.SystemRoot || "C:\\Windows", "SysWOW64"),
    process.env.ProgramData, path.join(process.env.ProgramData || "", "Package Cache"), process.env.LOCALAPPDATA, process.env.APPDATA,
    path.join(process.env.LOCALAPPDATA || "", "Programs"), os.homedir(),
  ].filter(Boolean).map((p) => p.toLowerCase().replace(/\\+$/, ""))
);

function rootsFor(app) {
  const roots = new Set();
  const add = (p) => {
    if (!p) return;
    const r = p.toLowerCase().replace(/^"|"$/g, "").replace(/\\+$/, "");
    if (r.length < 4 || GENERIC.has(r) || r.includes("\\package cache\\") || r.startsWith((process.env.SystemRoot || "c:\\windows").toLowerCase())) return;
    roots.add(r);
  };
  add(app.location);
  const exe = exeFromIcon(app.icon);
  if (exe) add(path.dirname(exe));
  const un = (app.uninstall || "").match(/^"([^"]+\.exe)"|^(\S+\.exe)/i);
  if (un) add(path.dirname(un[1] || un[2]));
  return [...roots];
}

function exesIn(root, depth = 0, out = [], cap = 60) {
  if (out.length >= cap) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.isFile() && /\.exe$/i.test(e.name) && !/^(unins|uninstall|setup|update|crashpad|crash|helper)/i.test(e.name)) out.push(path.join(root, e.name).toLowerCase());
    else if (e.isDirectory() && depth < 1 && !e.isSymbolicLink()) exesIn(path.join(root, e.name), depth + 1, out, cap);
    if (out.length >= cap) break;
  }
  return out;
}

const RUNTIME = /redistributable|runtime|\.net|sdk|driver|драйвер|webview2|directx|visual c\+\+|windows kits|targeting pack|host ?fx|shared framework|apphost|templates|toolset|manifest|update health|vs_|icecap|windows software development|msi development|universal crt|entity framework|asp\.net|intellitrace|diagnostics hub|nuget|clicktonet|iis express|python launcher|windows app certification|winrt intellisense|kits configuration|microsoft edge|microsoft update|bonjour|physx|vulkan|realtek|chipset|amd software|nvidia (graphics|physx|hd audio|frameview|usbc)|intel\(r\) (management|serial|chipset)/i;

function parseInstallDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s || "");
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : 0;
}

async function folderSizes(paths) {
  if (!paths.length) return [];
  const list = path.join(os.tmpdir(), `largo-clean-sizes-${process.pid}.txt`);
  fs.writeFileSync(list, paths.join("\r\n"), "utf8");
  try {
    const out = await runPs("Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:LARGO_SCANNER_CS)) -Language CSharp; [LargoScanner]::Sizes($env:LARGO_LIST)", {
      LARGO_SCANNER_CS: sourcePath(),
      LARGO_LIST: list,
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(list, { force: true });
  }
}

async function listApps(iconTouchedAt, readShortcut, onProgress) {
  onProgress?.("Читаю список программ…");
  const [reg, steam] = await Promise.all([runPsJson(REGISTRY_PS), steamGames()]);
  const apps = (reg && reg.apps) || [];

  // История запусков. Пути храним без буквы диска: BAM отдаёт \Device\HarddiskVolumeN\…
  onProgress?.("Собираю историю запусков…");
  const usage = [];
  const note = (p, t, src) => {
    if (p && t > 0) usage.push({ tail: p.toLowerCase().replace(/^[a-z]:/, ""), t, src });
  };
  for (const u of (reg && reg.ua) || []) {
    const p = resolveUaPath(u.n);
    if (!p) continue;
    note(/\.lnk$/i.test(p) ? readShortcut(p) : p, u.t, "userassist");
  }
  for (const b of (reg && reg.bam) || []) note(b.n.replace(/^\\Device\\HarddiskVolume\d+/i, ""), b.t, "bam");
  const prefetch = prefetchTimes();

  // Дубли (x86/x64, HKLM/HKCU) и записи Steam из реестра — убираем
  const seen = new Map();
  for (const a of apps) {
    if (/^Steam App \d+$/.test(a.key.split("\\").pop()) || /^Steam App \d+/.test(a.name)) continue;
    const k = a.name.toLowerCase().trim();
    const prev = seen.get(k);
    if (!prev || (a.size || 0) > (prev.size || 0)) seen.set(k, a);
  }

  const list = [];
  for (const a of seen.values()) {
    const roots = rootsFor(a);
    const tails = roots.map((r) => r.replace(/^[a-z]:/, "") + "\\");
    let last = 0;
    let source = null;
    const bump = (t, src) => {
      if (t > last) {
        last = t;
        source = src;
      }
    };
    for (const u of usage) if (u.t > last && tails.some((r) => u.tail.startsWith(r))) bump(u.t, u.src);
    const exes = new Set(roots.flatMap((r) => exesIn(r)));
    const iconExe = exeFromIcon(a.icon);
    if (iconExe && /\.exe$/i.test(iconExe)) exes.add(iconExe.toLowerCase());
    const atimes = [];
    for (const exe of exes) {
      bump(prefetch.get(path.basename(exe)) || 0, "prefetch");
      try {
        // NTFS обновляет время доступа при запуске (с точностью ~1 ч). Если exe читали мы сами, извлекая иконку, — не считаем.
        const at = fs.statSync(exe).atimeMs;
        if (Math.abs(at - (iconTouchedAt(exe) || -1e15)) > 10 * 60 * 1000) atimes.push(at);
      } catch (_) {}
    }
    const isSystem = RUNTIME.test(a.name) || (/^(Microsoft Corporation|NVIDIA Corporation|Advanced Micro Devices|Intel)/i.test(a.publisher || "") && /driver|runtime|component|service|update|tools|sdk/i.test(a.name));
    list.push({
      atimes,
      id: a.key,
      kind: "app",
      name: a.name,
      publisher: a.publisher,
      version: a.version,
      location: roots[0] || "",
      ownRoot: rootsFor({ location: a.location })[0] || null,
      size: a.size > 0 && a.size < 300 * 2 ** 30 ? a.size : 0, // EstimatedSize бывает мусорным
      lastUsed: last,
      usageSource: source,
      canTrack: exes.size > 0 || roots.length > 0,
      installDate: parseInstallDate(a.installDate),
      uninstall: a.uninstall,
      iconFile: iconExe || [...exes][0] || null,
      system: Boolean(isSystem),
    });
  }

  // Время доступа как признак запуска. Антивирус или индексатор иногда разом «трогают» exe десятков программ —
  // такие минуты, общие для многих программ, отбрасываем.
  const perMinute = new Map();
  for (const a of list) for (const m of new Set(a.atimes.map((t) => Math.floor(t / 60000)))) perMinute.set(m, (perMinute.get(m) || 0) + 1);
  for (const a of list) {
    for (const t of a.atimes) {
      if (t > a.lastUsed && (perMinute.get(Math.floor(t / 60000)) || 0) < 4) {
        a.lastUsed = t;
        a.usageSource = "atime";
      }
    }
    delete a.atimes;
  }

  // Реальные размеры папок (EstimatedSize в реестре часто пустой или устаревший).
  // Папку не считаем, если она общая для нескольких программ (C:\Program Files\Adobe) или содержит чужую.
  onProgress?.("Считаю размеры папок…");
  const owned = list.map((a) => a.ownRoot).filter(Boolean);
  const need = list.filter((a) => {
    const r = a.ownRoot;
    if (!r || !fs.existsSync(r)) return false;
    return !owned.some((o) => o !== r ? o.startsWith(r + "\\") : false) && owned.filter((o) => o === r).length === 1;
  });
  try {
    const sizes = await folderSizes(need.map((a) => a.ownRoot));
    need.forEach((a, i) => {
      if (sizes[i] > 0) a.size = sizes[i];
    });
  } catch (_) {}
  for (const a of list) delete a.ownRoot;

  return { apps: [...list, ...steam], prefetch: prefetch.size > 0, history: usage.length > 0 };
}

// Запуск штатного деинсталлятора — с его собственными окнами и подтверждениями.
function uninstall(app, openExternal) {
  if (app.kind === "steam") {
    openExternal("steam://uninstall/" + app.appid);
    return { ok: true };
  }
  let cmd = (app.uninstall || "").trim();
  if (!cmd) return { ok: false, error: "У программы нет деинсталлятора в реестре" };
  cmd = cmd.replace(/^(msiexec(\.exe)?)\s+\/I\s*/i, "$1 /X");
  const child = spawn(cmd, { shell: true, detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {});
  child.unref();
  return { ok: true };
}

module.exports = { listApps, uninstall };
