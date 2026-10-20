"use strict";

const { app, BrowserWindow, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const { runPs, runPsJson } = require("./ps");
const { scanDrive } = require("./scanner");
const cleaner = require("./cleaner");
const apps = require("./apps");

let mainWindow = null;
let currentScan = null;
let appCache = new Map();

const publicDir = path.join(__dirname, "..", "public");

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function isAdmin() {
  return new Promise((resolve) => execFile("net", ["session"], { windowsHide: true }, (err) => resolve(!err)));
}

async function drives() {
  const list = await runPsJson(
    "@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { [pscustomobject]@{ id=$_.DeviceID; label=[string]$_.VolumeName; size=[int64]$_.Size; free=[int64]$_.FreeSpace } }) | ConvertTo-Json -Compress"
  );
  return Array.isArray(list) ? list : list ? [list] : [];
}

async function hibernation() {
  try {
    const st = fs.statSync("C:\\hiberfil.sys");
    return { enabled: true, size: st.size };
  } catch (e) {
    // файл занят системой — stat может не пройти, размер берём из списка папки
    try {
      const size = Number(await runPs("(Get-Item -Force 'C:\\hiberfil.sys').Length"));
      return { enabled: size > 0, size: size || 0 };
    } catch (_) {
      return { enabled: false, size: 0 };
    }
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: "#0f0f0f",
    show: false,
    title: "Largo Clean",
    icon: path.join(publicDir, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(publicDir, "index.html"));
  mainWindow.once("ready-to-show", () => mainWindow.show());
  if (process.env.LARGO_SHOT) captureForReview(process.env.LARGO_SHOT);
  mainWindow.on("maximize", () => send("window:state", { maximized: true }));
  mainWindow.on("unmaximize", () => send("window:state", { maximized: false }));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// Отладка: LARGO_SHOT=<папка> снимает скриншоты всех разделов и закрывает приложение.
async function captureForReview(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => fs.writeFileSync(path.join(dir, name + ".png"), (await mainWindow.capturePage()).toPNG());
  await wait(4000);
  await shot("0-scanning");
  await wait(22000);
  await shot("1-overview");
  await mainWindow.webContents.executeJavaScript("document.querySelector('.content').scrollTop = 600");
  await wait(500);
  await shot("2-overview-bottom");
  await mainWindow.webContents.executeJavaScript("document.querySelector('.content').scrollTop = 0; document.querySelector('[data-page=clean]').click()");
  await wait(1500);
  await shot("3-clean");
  await mainWindow.webContents.executeJavaScript("document.querySelector('[data-page=apps]').click()");
  await wait(2500);
  await shot("4-apps");
  await mainWindow.webContents.executeJavaScript("document.querySelector('[data-filter=all]').click()");
  await wait(1500);
  await shot("5-apps-all");
  app.quit();
}

// ---- система ----
ipcMain.handle("sys:info", async () => {
  const [admin, list, hib] = await Promise.all([isAdmin(), drives(), hibernation()]);
  return { admin, drives: list, hibernation: hib, version: app.getVersion() };
});

ipcMain.handle("sys:relaunchAdmin", async () => {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [path.join(__dirname, "..")];
  const argList = args.length ? `-ArgumentList '${args.map((a) => `"${a}"`).join(" ").replace(/'/g, "''")}'` : "";
  try {
    await runPs(`Start-Process -FilePath '${exe.replace(/'/g, "''")}' ${argList} -Verb RunAs -ErrorAction Stop; 'ok'`);
    app.quit();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "Запуск от администратора отменён" };
  }
});

ipcMain.handle("sys:hibernateOff", async () => {
  if (!(await isAdmin())) return { ok: false, error: "Нужны права администратора" };
  await new Promise((resolve) => execFile("powercfg", ["/h", "off"], { windowsHide: true }, () => resolve()));
  return { ok: true, hibernation: await hibernation() };
});

// ---- анализ диска ----
ipcMain.handle("scan:start", async (_e, root) => {
  if (currentScan) currentScan.cancel();
  const scan = scanDrive(root, (p) => send("scan:progress", p));
  currentScan = scan;
  try {
    const result = await scan.promise;
    return result ? { ok: true, result } : { ok: false, cancelled: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    if (currentScan === scan) currentScan = null;
  }
});
ipcMain.handle("scan:cancel", () => currentScan && currentScan.cancel());

// ---- очистка ----
let targetCache = [];
ipcMain.handle("clean:targets", async () => {
  targetCache = await cleaner.targets();
  return targetCache.map(({ id, group, title, desc, admin, on, minAge, recycle }) => ({ id, group, title, desc, admin: Boolean(admin), on, minAge: minAge || 0, recycle: Boolean(recycle) }));
});
ipcMain.handle("clean:measure", async () => {
  if (!targetCache.length) targetCache = await cleaner.targets();
  return cleaner.measureAll(targetCache);
});
ipcMain.handle("clean:run", async (_e, ids) => {
  const chosen = targetCache.filter((t) => ids.includes(t.id));
  try {
    const res = await cleaner.cleanAll(chosen, (p) => send("clean:progress", p));
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// ---- приложения ----
ipcMain.handle("apps:list", async () => {
  const r = await apps.listApps(
    iconTouchedAt,
    (lnk) => {
      try {
        return shell.readShortcutLink(lnk).target || null;
      } catch (_) {
        return null;
      }
    },
    (msg) => send("apps:progress", msg)
  );
  appCache = new Map(r.apps.map((a) => [a.id, a]));
  return r;
});
ipcMain.handle("apps:uninstall", (_e, id) => {
  const a = appCache.get(id);
  if (!a) return { ok: false, error: "Приложение не найдено, обновите список" };
  return apps.uninstall(a, (url) => shell.openExternal(url));
});
// Иконки: кэш на диске. Извлечение иконки читает exe и сдвигает его «время доступа»,
// по которому считается последний запуск, — поэтому время восстанавливаем и запоминаем момент извлечения.
const iconFile = () => path.join(app.getPath("userData"), "icons.json");
let iconCache = null;
function icons() {
  if (!iconCache) {
    try {
      iconCache = JSON.parse(fs.readFileSync(iconFile(), "utf8"));
    } catch (_) {
      iconCache = {};
    }
  }
  return iconCache;
}
let saveTimer = null;
function saveIcons() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(iconFile(), JSON.stringify(iconCache));
    } catch (_) {}
  }, 1500);
}
function iconTouchedAt(file) {
  const e = icons()[file.toLowerCase()];
  return e ? e.at : 0;
}
ipcMain.handle("apps:icon", async (_e, file) => {
  if (!file) return null;
  const key = file.toLowerCase();
  let st;
  try {
    st = fs.statSync(file);
  } catch (_) {
    return null;
  }
  const cached = icons()[key];
  if (cached && cached.mtime === st.mtimeMs) return cached.url;
  let url = null;
  try {
    if (/\.(jpg|jpeg|png|ico)$/i.test(file)) {
      const img = nativeImage.createFromPath(file);
      url = img.isEmpty() ? null : img.resize({ width: 64, height: 64, quality: "best" }).toDataURL();
    } else {
      url = (await app.getFileIcon(file, { size: "large" })).toDataURL();
    }
  } catch (_) {}
  try {
    fs.utimesSync(file, st.atime, st.mtime);
  } catch (_) {
    /* нет прав на запись атрибутов — учтём через at */
  }
  icons()[key] = { mtime: st.mtimeMs, url, at: Date.now() };
  saveIcons();
  return url;
});

// ---- оболочка ----
ipcMain.handle("shell:reveal", (_e, p) => shell.showItemInFolder(p));
ipcMain.handle("shell:open", (_e, p) => shell.openPath(p));
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:maximize", () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()));
ipcMain.handle("window:close", () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(createWindow);
  app.on("window-all-closed", () => {
    if (currentScan) currentScan.cancel();
    app.quit();
  });
}
