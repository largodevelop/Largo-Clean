"use strict";

// Мост к scanner.cs: компилирует его через Add-Type и читает вывод построчно.
// Протокол: строки "P\t…" — прогресс, одна строка "R\t<json>" — результат.
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnPs } = require("./ps");

function sourcePath() {
  const p = path.join(__dirname, "scanner.cs");
  // в собранном приложении файл лежит рядом с asar: PowerShell не читает из архива
  return p.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);
}

function runCs(call, env, onProgress) {
  let child = null;
  const promise = new Promise((resolve, reject) => {
    const script = `Add-Type -TypeDefinition ([IO.File]::ReadAllText($env:LARGO_SCANNER_CS)) -Language CSharp; ${call}`;
    child = spawnPs(script, { LARGO_SCANNER_CS: sourcePath(), ...env });
    let buf = "";
    let result = null;
    const err = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.startsWith("P\t")) onProgress?.(line.split("\t").slice(1));
        else if (line.startsWith("R\t")) result = JSON.parse(line.slice(2));
      }
    });
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (result) resolve(result);
      else if (child.killed) resolve(null);
      else reject(new Error(Buffer.concat(err).toString("utf8").trim() || `scanner exit ${code}`));
    });
  });
  return { promise, cancel: () => child && child.kill() };
}

function scanDrive(root, onProgress) {
  return runCs("[LargoScanner]::Run($env:LARGO_SCAN_ROOT)", { LARGO_SCAN_ROOT: root }, ([files, bytes, dir]) =>
    onProgress?.({ files: Number(files), bytes: Number(bytes), dir })
  );
}

// jobs: [{id, minAge, path}] → {id: {bytes, files, skipped}}
async function cleanPaths(jobs, dry, onProgress) {
  const list = path.join(os.tmpdir(), `largo-clean-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(list, jobs.map((j) => `${j.id}\t${Math.round(j.minAge || 0)}\t${j.path}`).join("\r\n"), "utf8");
  try {
    return await runCs(`[LargoScanner]::Clean($env:LARGO_LIST, $${dry ? "true" : "false"})`, { LARGO_LIST: list }, ([id, files, bytes]) =>
      onProgress?.({ id, files: Number(files), bytes: Number(bytes) })
    ).promise;
  } finally {
    fs.rmSync(list, { force: true });
  }
}

module.exports = { scanDrive, cleanPaths, sourcePath };
