"use strict";

// FPS и время кадра через Intel PresentMon (ETW, без внедрения в игру). Нужны права администратора.
const path = require("path");
const fs = require("fs");
const { spawn, execFileSync } = require("child_process");

const WINDOW_MS = 1000; // окно для FPS
const LOW_MS = 10000; // окно для 1% low
const SESSION = "LargoClean";
const IGNORE = new Set(["dwm.exe", "largo clean.exe", "electron.exe", "presentmon-2.6.0-x64.exe"]);

function createFps({ exe }) {
  const frames = new Map(); // pid → [{t, ft}]
  const names = new Map();
  let child = null;
  let stopped = false;
  let error = null;

  function start() {
    if (stopped || child) return;
    if (!fs.existsSync(exe)) {
      error = "PresentMon не найден";
      return;
    }
    // ETW-сессия переживает убитый процесс: закрываем оставшуюся от прошлого запуска.
    // (--stop_existing_session в PresentMon 2.6 запускает сессию без вывода)
    terminateSession();
    child = spawn(exe, ["--output_stdout", "--no_console_stats", "--session_name", SESSION, "--v2_metrics"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    let cols = null;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let i;
      const now = Date.now();
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const parts = line.split(",");
        if (!cols) {
          cols = { app: parts.indexOf("Application"), pid: parts.indexOf("ProcessID"), ft: parts.indexOf("FrameTime") };
          continue;
        }
        const app = parts[cols.app];
        if (!app || IGNORE.has(app.toLowerCase())) continue;
        const pid = Number(parts[cols.pid]);
        const ft = Number(parts[cols.ft]);
        if (!(ft > 0)) continue;
        names.set(pid, app);
        if (!frames.has(pid)) frames.set(pid, []);
        frames.get(pid).push({ t: now, ft });
      }
    });
    let errText = "";
    child.stderr.on("data", (d) => (errText += d));
    child.on("exit", (code) => {
      child = null;
      if (code && !stopped) error = /admin|privilege|access/i.test(errText) ? "Нужны права администратора" : `PresentMon завершился (${code})`;
    });
    child.on("error", (e) => (error = String(e.message || e)));
  }

  function terminateSession() {
    try {
      execFileSync(exe, ["--session_name", SESSION, "--terminate_existing_session"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    } catch (_) {}
  }

  function prune() {
    const cut = Date.now() - LOW_MS;
    for (const [pid, list] of frames) {
      let k = 0;
      while (k < list.length && list[k].t < cut) k++;
      if (k) list.splice(0, k);
      if (!list.length) {
        frames.delete(pid);
        names.delete(pid);
      }
    }
  }

  /** Метрики процесса pid (или самого активного по кадрам, если pid не рисует). */
  function stats(pid) {
    prune();
    let list = frames.get(pid);
    let usePid = pid;
    if (!list || !list.length) {
      let best = null;
      for (const [p, l] of frames) if (!best || l.length > best[1].length) best = [p, l];
      if (!best) return { fps: null, error };
      [usePid, list] = best;
    }
    const now = Date.now();
    const recent = list.filter((f) => f.t >= now - WINDOW_MS);
    if (!recent.length) return { fps: null, error };
    const sum = recent.reduce((a, f) => a + f.ft, 0);
    const sorted = list.map((f) => f.ft).sort((a, b) => a - b);
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))];
    return {
      fps: Math.round((recent.length * 1000) / Math.max(sum, 1)),
      frametime: sum / recent.length,
      low1: p99 ? Math.round(1000 / p99) : null,
      graph: list.slice(-120).map((f) => Math.round(f.ft * 10) / 10),
      app: names.get(usePid) || null,
      pid: usePid,
      error: null,
    };
  }

  start();
  return {
    stats,
    stop() {
      stopped = true;
      if (child) child.kill();
      terminateSession();
    },
  };
}

module.exports = { createFps };
