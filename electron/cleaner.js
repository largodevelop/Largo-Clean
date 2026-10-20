"use strict";

// Цели очистки: только заранее известные папки временных файлов и кэшей.
// Удаляется содержимое (не сама папка), ссылки/junction'ы не обходятся, занятые файлы пропускаются.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { runPs, runPsJson } = require("./ps");
const { cleanPaths } = require("./scanner");

const env = process.env;
const LOCAL = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
const ROAMING = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const WINDIR = env.SystemRoot || "C:\\Windows";
const PROGRAMDATA = env.ProgramData || "C:\\ProgramData";
const DAY = 24 * 60 * 60 * 1000;

function existing(list) {
  return list.filter((p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch (_) {
      return false;
    }
  });
}

// Подпапки профилей Chromium-браузеров: только кэши, не история, пароли или куки.
function chromiumCaches(userData) {
  const out = [];
  let profiles = [];
  try {
    profiles = fs.readdirSync(userData, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (_) {
    return out;
  }
  for (const prof of profiles) {
    if (!(prof === "Default" || /^Profile \d+$/.test(prof) || prof === "Guest Profile")) continue;
    for (const sub of ["Cache", "Code Cache", "GPUCache", "Service Worker\\CacheStorage", "Service Worker\\ScriptCache"]) {
      out.push(path.join(userData, prof, sub));
    }
  }
  for (const sub of ["ShaderCache", "GrShaderCache", "GraphiteDawnCache", "component_crx_cache"]) out.push(path.join(userData, sub));
  return out;
}

function electronAppCaches(dir) {
  return ["Cache", "Code Cache", "GPUCache", "DawnCache", "DawnGraphiteCache", "DawnWebGPUCache"].map((s) => path.join(dir, s));
}

let steamPathCache;
async function steamPath() {
  if (steamPathCache !== undefined) return steamPathCache;
  try {
    const out = await runPs("(Get-ItemProperty 'HKCU:\\Software\\Valve\\Steam').SteamPath");
    steamPathCache = out ? path.normalize(out.trim()) : null;
  } catch (_) {
    steamPathCache = null;
  }
  return steamPathCache;
}

async function targets() {
  const steam = await steamPath();
  const firefoxProfiles = existing([path.join(LOCAL, "Mozilla", "Firefox", "Profiles")]).flatMap((p) => {
    try {
      return fs.readdirSync(p).map((n) => path.join(p, n, "cache2"));
    } catch (_) {
      return [];
    }
  });
  return [
    {
      id: "win-temp", group: "system", title: "Временные файлы Windows", desc: "C:\\Windows\\Temp — остатки установщиков и обновлений",
      paths: [path.join(WINDIR, "Temp")], minAge: DAY, admin: true, on: true,
    },
    {
      id: "user-temp", group: "system", title: "Временные файлы пользователя", desc: "%TEMP% — файлы, которые программы забыли за собой удалить",
      paths: [path.join(LOCAL, "Temp")], minAge: DAY, on: true,
    },
    {
      id: "wu-cache", group: "system", title: "Загрузки Центра обновления", desc: "Уже установленные пакеты обновлений Windows",
      paths: [path.join(WINDIR, "SoftwareDistribution", "Download")], minAge: 7 * DAY, admin: true, on: true,
    },
    {
      id: "do-cache", group: "system", title: "Кэш оптимизации доставки", desc: "Обновления, которыми Windows делится с другими ПК",
      paths: [path.join(WINDIR, "ServiceProfiles", "NetworkService", "AppData", "Local", "Microsoft", "Windows", "DeliveryOptimization", "Cache")], admin: true, on: true,
    },
    {
      id: "wer", group: "system", title: "Отчёты об ошибках", desc: "Отчёты Windows Error Reporting и дампы падений программ",
      paths: [path.join(PROGRAMDATA, "Microsoft", "Windows", "WER", "ReportArchive"), path.join(PROGRAMDATA, "Microsoft", "Windows", "WER", "ReportQueue"), path.join(LOCAL, "CrashDumps"), path.join(LOCAL, "Microsoft", "Windows", "WER")], on: true,
    },
    {
      id: "gpu-cache", group: "gpu", title: "Кэш шейдеров видеокарты", desc: "NVIDIA / AMD / DirectX — пересоберётся сам, первый запуск игр будет чуть дольше",
      paths: [path.join(LOCAL, "NVIDIA", "DXCache"), path.join(LOCAL, "NVIDIA", "GLCache"), path.join(LOCAL, "AMD", "DxCache"), path.join(LOCAL, "AMD", "DxcCache"), path.join(LOCAL, "AMD", "VkCache"), path.join(LOCAL, "D3DSCache"), path.join(LOCAL, "NVIDIA Corporation", "NV_Cache")], on: true,
    },
    {
      id: "steam-cache", group: "gpu", title: "Кэш Steam", desc: "Кэш шейдеров игр, веб-кэш клиента, логи и дампы",
      paths: steam ? [path.join(steam, "steamapps", "shadercache"), path.join(steam, "appcache", "httpcache"), path.join(steam, "htmlcache"), path.join(steam, "logs"), path.join(steam, "dumps")] : [], on: true,
    },
    {
      id: "browser-cache", group: "apps", title: "Кэш браузеров", desc: "Chrome, Edge, Яндекс, Opera, Brave, Firefox — только кэш, без истории и паролей",
      paths: [
        ...chromiumCaches(path.join(LOCAL, "Google", "Chrome", "User Data")),
        ...chromiumCaches(path.join(LOCAL, "Microsoft", "Edge", "User Data")),
        ...chromiumCaches(path.join(LOCAL, "Yandex", "YandexBrowser", "User Data")),
        ...chromiumCaches(path.join(LOCAL, "BraveSoftware", "Brave-Browser", "User Data")),
        ...electronAppCaches(path.join(ROAMING, "Opera Software", "Opera Stable")),
        ...electronAppCaches(path.join(LOCAL, "Opera Software", "Opera Stable")),
        ...firefoxProfiles,
      ], on: true,
    },
    {
      id: "app-cache", group: "apps", title: "Кэш мессенджеров и редакторов", desc: "Discord, Slack, Teams, VS Code, Cursor — веб-кэш интерфейса",
      paths: ["discord", "Slack", "Microsoft\\Teams", "Code", "Cursor", "Notion", "Figma"].flatMap((n) => electronAppCaches(path.join(ROAMING, n))),
      on: true,
    },
    {
      id: "dev-cache", group: "dev", title: "Кэши пакетов для разработки", desc: "npm, pip, NuGet, yarn, pnpm — скачаются заново при следующей сборке",
      paths: [path.join(LOCAL, "npm-cache"), path.join(ROAMING, "npm-cache"), path.join(LOCAL, "pip", "cache"), path.join(LOCAL, "NuGet", "v3-cache"), path.join(LOCAL, "NuGet", "plugins-cache"), path.join(os.homedir(), ".nuget", "packages"), path.join(LOCAL, "Yarn", "Cache"), path.join(LOCAL, "pnpm-cache"), path.join(os.homedir(), ".cache", "pip")],
      on: false,
    },
    {
      id: "recycle", group: "recycle", title: "Корзина", desc: "Удаление из корзины необратимо",
      paths: [], recycle: true, on: false,
    },
  ];
}

async function recycleSize() {
  try {
    const r = await runPsJson(
      "$b=(New-Object -ComObject Shell.Application).NameSpace(10); $sz=0; $c=0; " +
        "foreach($i in $b.Items()){ $c++; $sz += [int64]$i.ExtendedProperty('System.Size') }; @{ bytes=[int64]$sz; files=$c } | ConvertTo-Json -Compress"
    );
    return r || { bytes: 0, files: 0 };
  } catch (_) {
    return { bytes: 0, files: 0 };
  }
}

function jobsFor(list) {
  const jobs = [];
  for (const t of list) {
    if (t.recycle) continue;
    for (const p of existing(t.paths)) jobs.push({ id: t.id, minAge: t.minAge || 0, path: p });
  }
  return jobs;
}

// {id: {bytes, files}} для всех целей
async function measureAll(list) {
  const [res, bin] = await Promise.all([cleanPaths(jobsFor(list), true), list.some((t) => t.recycle) ? recycleSize() : null]);
  const out = {};
  for (const t of list) out[t.id] = t.recycle ? { ...bin, skipped: 0 } : (res && res[t.id]) || { bytes: 0, files: 0, skipped: 0 };
  return out;
}

async function cleanAll(list, onProgress) {
  const out = await cleanPaths(jobsFor(list), false, onProgress) || {};
  const bin = list.find((t) => t.recycle);
  if (bin) {
    const before = await recycleSize();
    await runPs("Clear-RecycleBin -Force -ErrorAction SilentlyContinue");
    const after = await recycleSize();
    out[bin.id] = { bytes: Math.max(0, before.bytes - after.bytes), files: Math.max(0, before.files - after.files), skipped: after.files };
  }
  return out;
}

module.exports = { targets, measureAll, cleanAll };
