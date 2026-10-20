"use strict";

// Автообновление из релизов GitHub: проверка, загрузка zip, подмена файлов программы и перезапуск.
const fs = require("fs");
const os = require("os");
const path = require("path");
const https = require("https");
const { spawn } = require("child_process");

const REPO = "largodevelop/Largo-Clean";
const ASSET = "LargoClean-win.zip";
const API = process.env.LARGO_UPDATE_API || `https://api.github.com/repos/${REPO}/releases/latest`;

function parseVersion(text) {
  const parts = String(text || "").trim().replace(/^v/i, "").split(".").map((chunk) => parseInt(chunk, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3);
}

function isNewer(tag, current) {
  const a = parseVersion(tag);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("http://") ? require("http") : https;
    const req = client.get(url, { headers: { "User-Agent": "LargoClean-Updater", ...headers } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        resolve(request(new URL(res.headers.location, url).toString(), headers));
        return;
      }
      resolve(res);
    });
    req.setTimeout(20000, () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

async function checkForUpdate(currentVersion) {
  try {
    const res = await request(API, { Accept: "application/vnd.github+json" });
    if (res.statusCode !== 200) {
      res.resume();
      return { available: false };
    }
    const chunks = [];
    for await (const chunk of res) chunks.push(chunk);
    const release = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tag = String(release.tag_name || "");
    if (release.draft || release.prerelease || !tag || !isNewer(tag, currentVersion)) return { available: false, latest: tag };
    const asset = (release.assets || []).find((item) => item.name === ASSET);
    if (!asset) return { available: false, latest: tag };
    return { available: true, latest: tag, url: asset.browser_download_url, size: Number(asset.size) || 0 };
  } catch (error) {
    return { available: false, error: String(error && error.message || error) };
  }
}

async function download(info, onProgress) {
  const dest = path.join(os.tmpdir(), `largo-clean-${info.latest}.zip`);
  const part = `${dest}.part`;
  const res = await request(info.url);
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`Загрузка не удалась (${res.statusCode}).`);
  }
  const total = Number(res.headers["content-length"]) || info.size || 0;
  let written = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(part);
    res.on("data", (chunk) => {
      written += chunk.length;
      if (onProgress && total) onProgress(written / total);
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });
  if (info.size && fs.statSync(part).size !== info.size) {
    fs.unlinkSync(part);
    throw new Error("Файл обновления скачался не полностью.");
  }
  fs.renameSync(part, dest);
  return dest;
}

// Скрипт (PowerShell) ждёт выхода программы, распаковывает архив, копирует файлы поверх и запускает программу снова.
function psq(text) {
  return `'${String(text).replace(/'/g, "''")}'`;
}

function applyAndRestart(zipPath, appDir, exePath, pid) {
  const work = path.join(os.tmpdir(), `largo-clean-update-${Date.now()}`);
  const script = path.join(os.tmpdir(), "largo-clean-apply.ps1");
  const log = path.join(os.tmpdir(), "largo-clean-update.log");
  const lines = [
    "$ErrorActionPreference = 'Continue'",
    `Start-Transcript -Path ${psq(log)} -Force | Out-Null`,
    `$zip = ${psq(zipPath)}`,
    `$work = ${psq(work)}`,
    `$app = ${psq(appDir)}`,
    `$exe = ${psq(exePath)}`,
    `try { Wait-Process -Id ${Number(pid)} -Timeout 60 -ErrorAction SilentlyContinue } catch {}`,
    // дождаться, пока закроются все процессы из папки программы (окна, датчики, PresentMon)
    "function Get-AppProcs { Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, [StringComparison]::OrdinalIgnoreCase) } }",
    "for ($i = 0; $i -lt 30 -and (Get-AppProcs); $i++) { Start-Sleep -Seconds 1 }",
    "Get-AppProcs | ForEach-Object { 'kill ' + $_.Name; Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
    "Start-Sleep -Seconds 1",
    // tar из Windows распаковывает zip за секунды; Expand-Archive в PowerShell 5.1 — минутами
    "New-Item -ItemType Directory -Force -Path $work | Out-Null",
    "& tar.exe -xf $zip -C $work",
    "if ($LASTEXITCODE -ne 0) { 'tar failed, Expand-Archive'; Expand-Archive -Force -LiteralPath $zip -DestinationPath $work }",
    "$copied = $false",
    "for ($i = 0; $i -lt 20 -and -not $copied; $i++) {",
    "  robocopy $work $app /MIR /R:2 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null",
    "  'robocopy ' + $LASTEXITCODE",
    "  if ($LASTEXITCODE -lt 8) { $copied = $true } else { Start-Sleep -Seconds 1 }",
    "}",
    "Start-Process -FilePath $exe -WorkingDirectory $app",
    "Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue",
    "if ($copied) { Remove-Item -Force $zip -ErrorAction SilentlyContinue }",
    "Stop-Transcript | Out-Null",
    "Remove-Item -Force $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue",
  ];
  fs.writeFileSync(script, "﻿" + lines.join("\r\n"), "utf8");
  // detached: иначе Node держит скрипт в своём Job Object и Windows убивает его вместе с программой
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

module.exports = { checkForUpdate, download, applyAndRestart, isNewer, REPO, ASSET };
