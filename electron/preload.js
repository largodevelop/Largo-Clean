"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const on = (channel) => (cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld("largo", {
  info: () => ipcRenderer.invoke("sys:info"),
  drives: () => ipcRenderer.invoke("sys:drives"),
  getUpdate: () => ipcRenderer.invoke("update:status"),
  installUpdate: () => ipcRenderer.invoke("update:install"),
  onUpdateChanged: on("update:changed"),
  relaunchAdmin: () => ipcRenderer.invoke("sys:relaunchAdmin"),
  hibernateOff: () => ipcRenderer.invoke("sys:hibernateOff"),

  scan: (root) => ipcRenderer.invoke("scan:start", root),
  cancelScan: () => ipcRenderer.invoke("scan:cancel"),
  onScanProgress: on("scan:progress"),

  cleanTargets: () => ipcRenderer.invoke("clean:targets"),
  cleanMeasure: () => ipcRenderer.invoke("clean:measure"),
  clean: (ids) => ipcRenderer.invoke("clean:run", ids),
  onCleanProgress: on("clean:progress"),

  apps: () => ipcRenderer.invoke("apps:list"),
  uninstall: (id) => ipcRenderer.invoke("apps:uninstall", id),
  icon: (file) => ipcRenderer.invoke("apps:icon", file),
  onAppsProgress: on("apps:progress"),

  hwState: () => ipcRenderer.invoke("hw:state"),
  onHwSample: on("hw:sample"),
  onFps: on("hw:fps"),
  setFan: (id, cfg) => ipcRenderer.invoke("fan:set", id, cfg),
  setOverlay: (patch) => ipcRenderer.invoke("overlay:set", patch).then((r) => (ipcRenderer.send("overlay:changed"), r)),
  onOverlaySettings: on("overlay:settings"),
  installPawnio: () => ipcRenderer.invoke("hw:installPawnio"),
  quit: () => ipcRenderer.invoke("app:quit"),

  reveal: (p) => ipcRenderer.invoke("shell:reveal", p),
  open: (p) => ipcRenderer.invoke("shell:open", p),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  maximize: () => ipcRenderer.invoke("window:maximize"),
  close: () => ipcRenderer.invoke("window:close"),
  onWindowState: on("window:state"),
});
