"use strict";

// Мост к bin/sensors/largo-sensors.exe (LibreHardwareMonitor): показания раз в секунду, команды вентиляторам.
const path = require("path");
const fs = require("fs");
const { spawn, execFile } = require("child_process");

function binDir(app) {
  return app.isPackaged ? path.join(process.resourcesPath, "bin") : path.join(__dirname, "..", "bin");
}

function createSensors({ app, onSample, onError }) {
  const exe = path.join(binDir(app), "sensors", "largo-sensors.exe");
  let child = null;
  let stopped = false;
  let restarts = 0;
  let pending = [];

  function start() {
    if (stopped || child || !fs.existsSync(exe)) return;
    child = spawn(exe, ["--parent", String(process.pid)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === "sample") {
            restarts = 0;
            onSample(msg);
          } else if (msg.type === "error") onError?.(msg.error);
        } catch (_) {}
      }
    });
    child.on("exit", () => {
      child = null;
      if (!stopped && restarts++ < 5) setTimeout(start, 2000);
    });
    child.on("error", (e) => onError?.(String(e.message || e)));
    for (const c of pending) send(c);
    pending = [];
  }

  function send(cmd) {
    if (!child) {
      pending.push(cmd);
      return;
    }
    try {
      child.stdin.write(JSON.stringify(cmd) + "\n");
    } catch (_) {}
  }

  function stop() {
    stopped = true;
    if (!child) return;
    // штатный выход: хелпер вернёт вентиляторы под управление BIOS
    send({ cmd: "quit" });
    const c = child;
    setTimeout(() => c && c.kill(), 1500);
  }

  start();
  return { send, stop, restart: () => ((stopped = false), start()) };
}

/** Установлен ли драйвер PawnIO (нужен LibreHardwareMonitor для температуры CPU и вентиляторов платы). */
function pawnioInstalled() {
  // вывод sc локализован («Состояние» вместо STATE), а тип драйвера — нет
  return new Promise((resolve) => execFile("sc", ["query", "PawnIO"], { windowsHide: true }, (err, out) => resolve(!err && /KERNEL_DRIVER/.test(out || ""))));
}

module.exports = { createSensors, pawnioInstalled, binDir };
