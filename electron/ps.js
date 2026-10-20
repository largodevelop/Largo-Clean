"use strict";

// Запуск PowerShell-скриптов: скрипт уходит через -EncodedCommand, вывод — UTF-8.
const { spawn } = require("child_process");

const PREFIX = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue';\n";

function spawnPs(script, env = {}) {
  const encoded = Buffer.from(PREFIX + script, "utf16le").toString("base64");
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function runPs(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPs(script, env);
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      const text = Buffer.concat(out).toString("utf8").trim();
      if (code !== 0 && !text) reject(new Error(Buffer.concat(err).toString("utf8") || `powershell exit ${code}`));
      else resolve(text);
    });
  });
}

async function runPsJson(script, env = {}) {
  const text = await runPs(script, env);
  if (!text) return null;
  return JSON.parse(text);
}

module.exports = { spawnPs, runPs, runPsJson };
