"use strict";

// Monitor, Fan Speed и Overlay: сводка датчиков, настройки вентиляторов и окно оверлея поверх игр.
const path = require("path");
const fs = require("fs");
const { BrowserWindow, screen, globalShortcut, ipcMain, shell } = require("electron");
const { createSensors, pawnioInstalled, binDir } = require("./sensors");
const { createFps } = require("./fps");
const win32 = require("./win32");

const DEFAULT_OVERLAY = {
  enabled: false,
  style: 2,
  corner: "tl",
  scale: 100,
  bg: 60,
  onlyGames: true,
  hotkey: "Ctrl+Shift+O",
  metrics: { fps: true, frametime: true, low1: false, graph: true, gpuLoad: true, gpuTemp: true, gpuClock: false, gpuPower: false, vram: false, cpuLoad: true, cpuTemp: true, cpuClock: false, ram: true, time: false },
};

function readJson(file, fallback) {
  try {
    return { ...fallback, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch (_) {
    return { ...fallback };
  }
}

// ---- сводка LibreHardwareMonitor → то, что показывает интерфейс ----
function summarize(sample) {
  const hw = sample.hardware || [];
  const find = (h, type, re) => (h ? h.sensors.find((s) => s.type === type && re.test(s.name)) : null);
  const val = (s) => (s && s.value != null ? s.value : null);
  // без драйвера датчики платы отдают 0 — для температур, частот и мощности это «нет данных»
  const nz = (s) => (s && s.value ? s.value : null);

  const cpu = hw.find((h) => h.type === "Cpu");
  const gpu = hw.find((h) => /^Gpu/.test(h.type));
  const ram = hw.find((h) => h.type === "Memory" && /Total|Generic|^Memory$/i.test(h.name)) || hw.find((h) => h.type === "Memory" && !/Virtual/i.test(h.name));
  const nics = hw.filter((h) => h.type === "Network");
  const disks = hw.filter((h) => h.type === "Storage");

  const gpuMemUsed = val(find(gpu, "SmallData", /^GPU Memory Used$/));
  const gpuMemTotal = val(find(gpu, "SmallData", /^GPU Memory Total$/));
  const ramUsed = val(find(ram, "Data", /Memory Used/));
  const ramFree = val(find(ram, "Data", /Memory Available/));

  // основной адаптер — с наибольшим трафиком
  let net = { name: null, down: 0, up: 0 };
  for (const n of nics) {
    const down = val(find(n, "Throughput", /Download/)) || 0;
    const up = val(find(n, "Throughput", /Upload/)) || 0;
    if (down + up >= net.down + net.up) net = { name: n.name, down, up };
  }

  const temps = [];
  for (const h of hw) for (const s of h.sensors) if (s.type === "Temperature" && s.value && !/Warning|Critical|Limit/i.test(s.name)) temps.push({ id: s.id, name: `${h.name} · ${s.name}`, value: s.value });

  return {
    t: sample.t,
    admin: sample.admin,
    panic: sample.panic,
    cpu: cpu && {
      name: cpu.name,
      load: val(find(cpu, "Load", /^CPU Total$/)),
      temp: nz(find(cpu, "Temperature", /Tctl|Tdie|Package|Core \(Average\)|^Core Max$/)),
      clock: nz(find(cpu, "Clock", /Cores \(Average\)$/)) || nz(find(cpu, "Clock", /Core #1$/)),
      power: nz(find(cpu, "Power", /^Package$/)),
      threads: cpu.sensors.filter((s) => s.type === "Load" && /^CPU Core #\d+$/.test(s.name)).map((s) => s.value),
    },
    gpu: gpu && {
      name: gpu.name,
      load: val(find(gpu, "Load", /^GPU Core$/)),
      temp: val(find(gpu, "Temperature", /^GPU Core$/)),
      hotspot: val(find(gpu, "Temperature", /Hot Spot/)),
      clock: val(find(gpu, "Clock", /^GPU Core$/)),
      power: val(find(gpu, "Power", /Package|Power$/)),
      memUsed: gpuMemUsed,
      memTotal: gpuMemTotal,
      fanRpm: val(find(gpu, "Fan", /Fan/)),
    },
    ram: { used: ramUsed, total: ramUsed != null && ramFree != null ? ramUsed + ramFree : null, load: val(find(ram, "Load", /Memory/)) },
    disks: disks.map((d) => ({
      name: d.name,
      activity: val(find(d, "Load", /Total Activity/)),
      read: val(find(d, "Throughput", /Read Rate/)),
      write: val(find(d, "Throughput", /Write Rate/)),
      temp: val(find(d, "Temperature", /Composite|^Temperature$/)),
      used: val(find(d, "Load", /Used Space/)),
    })),
    net,
    fans: (sample.fans || []).map((f) => ({ id: f.id, name: f.name, hardware: f.hardware, rpm: f.rpm, pct: f.pct, mode: f.mode })),
    temps,
  };
}

function setupHardware({ app, getMainWindow }) {
  const userData = app.getPath("userData");
  const fanFile = path.join(userData, "fans.json");
  const overlayFile = path.join(userData, "overlay.json");
  let fanSettings = readJson(fanFile, {});
  let overlay = readJson(overlayFile, DEFAULT_OVERLAY);
  overlay.metrics = { ...DEFAULT_OVERLAY.metrics, ...(overlay.metrics || {}) };
  let latest = null;
  let lastError = null;
  let pawnio = false;
  pawnioInstalled().then((v) => (pawnio = v));

  const sendMain = (ch, data) => {
    const w = getMainWindow();
    if (w && !w.isDestroyed()) w.webContents.send(ch, data);
  };

  const sensors = createSensors({
    app,
    onSample: (s) => {
      latest = summarize(s);
      sendMain("hw:sample", { ...latest, pawnio, error: lastError });
    },
    onError: (e) => (lastError = e),
  });
  for (const [id, cfg] of Object.entries(fanSettings)) sensors.send({ cmd: "fan", id, ...cfg });

  const fps = createFps({ exe: path.join(binDir(app), "presentmon", "PresentMon-2.6.0-x64.exe") });

  // ---- окно оверлея ----
  let overlayWin = null;
  function ensureOverlay() {
    if (overlayWin && !overlayWin.isDestroyed()) return overlayWin;
    overlayWin = new BrowserWindow({
      width: 420, height: 260, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, skipTaskbar: true, alwaysOnTop: true, focusable: false,
      show: false, hasShadow: false, backgroundColor: "#00000000",
      webPreferences: { preload: path.join(__dirname, "overlay-preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    overlayWin.loadFile(path.join(__dirname, "..", "public", "overlay.html"));
    overlayWin.on("closed", () => (overlayWin = null));
    return overlayWin;
  }

  let lastSize = { w: 0, h: 0 };
  ipcMain.on("overlay:size", (_e, size) => (lastSize = { w: Math.ceil(size.w), h: Math.ceil(size.h) }));

  function tickOverlay() {
    const fg = (() => {
      try {
        return win32.foreground();
      } catch (_) {
        return null;
      }
    })();
    const ownPids = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)]);
    const isOwn = fg && ownPids.has(fg.pid);
    const st = fps.stats(fg && !isOwn ? fg.pid : -1);
    const gameActive = st.fps != null && fg && !isOwn && st.pid === fg.pid;

    sendMain("hw:fps", st);
    const show = overlay.enabled && (!overlay.onlyGames || gameActive);
    if (!show) {
      if (overlayWin && overlayWin.isVisible()) overlayWin.hide();
      return;
    }
    const win = ensureOverlay();
    win.webContents.send("overlay:data", { settings: overlay, hw: latest, fps: st });

    // угол экрана, на котором активное окно
    const center = fg ? screen.screenToDipPoint({ x: fg.rect.x + fg.rect.width / 2, y: fg.rect.y + fg.rect.height / 2 }) : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(center).bounds;
    const w = Math.max(60, lastSize.w), h = Math.max(30, lastSize.h), m = 12;
    const x = overlay.corner.endsWith("l") ? area.x + m : area.x + area.width - w - m;
    const y = overlay.corner.startsWith("t") ? area.y + m : area.y + area.height - h - m;
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h }, false);
    if (!win.isVisible()) win.showInactive();
    win.setAlwaysOnTop(true, "screen-saver");
  }
  const overlayTimer = setInterval(tickOverlay, 500);

  function registerHotkey() {
    globalShortcut.unregisterAll();
    if (!overlay.hotkey) return;
    try {
      globalShortcut.register(overlay.hotkey, () => {
        overlay.enabled = !overlay.enabled;
        saveOverlay();
        sendMain("overlay:settings", overlay);
      });
    } catch (_) {}
  }
  function saveOverlay() {
    try {
      fs.writeFileSync(overlayFile, JSON.stringify(overlay, null, 2));
    } catch (_) {}
  }
  registerHotkey();

  // ---- IPC ----
  ipcMain.handle("hw:state", () => ({ sample: latest && { ...latest, pawnio, error: lastError }, fans: fanSettings, overlay }));
  ipcMain.handle("fan:set", (_e, id, cfg) => {
    fanSettings[id] = cfg;
    if (cfg.mode === "auto") delete fanSettings[id];
    try {
      fs.writeFileSync(fanFile, JSON.stringify(fanSettings, null, 2));
    } catch (_) {}
    sensors.send({ cmd: "fan", id, ...cfg });
    return { ok: true };
  });
  ipcMain.handle("overlay:set", (_e, patch) => {
    overlay = { ...overlay, ...patch, metrics: { ...overlay.metrics, ...(patch.metrics || {}) } };
    saveOverlay();
    if (patch.hotkey !== undefined) registerHotkey();
    return overlay;
  });
  ipcMain.handle("hw:installPawnio", async () => {
    // официальный установщик PawnIO через winget: свои окна, подтверждение UAC
    const { spawn } = require("child_process");
    return new Promise((resolve) => {
      const p = spawn("winget", ["install", "--id", "namazso.PawnIO", "-e", "--accept-package-agreements", "--accept-source-agreements"], { windowsHide: false });
      p.on("exit", async (code) => {
        pawnio = await pawnioInstalled();
        if (pawnio) sensors.stop(), setTimeout(() => sensors.restart(), 2000);
        resolve({ ok: pawnio, code });
      });
      p.on("error", () => {
        shell.openExternal("https://pawnio.eu/");
        resolve({ ok: false, error: "winget недоступен — открыт сайт PawnIO" });
      });
    });
  });

  return {
    stop() {
      clearInterval(overlayTimer);
      globalShortcut.unregisterAll();
      sensors.stop();
      fps.stop();
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
    },
    overlay: () => overlay,
    toggleOverlay() {
      overlay.enabled = !overlay.enabled;
      saveOverlay();
      sendMain("overlay:settings", overlay);
      return overlay.enabled;
    },
  };
}

module.exports = { setupHardware };
