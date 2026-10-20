"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
  onData: (cb) => ipcRenderer.on("overlay:data", (_e, d) => cb(d)),
  size: (w, h) => ipcRenderer.send("overlay:size", { w, h }),
});
