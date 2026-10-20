"use strict";

// Тонкая обёртка над WinAPI через koffi (как в Largo Accept): активное окно и его процесс.
const koffi = require("koffi");

const user32 = koffi.load("user32.dll");
const RECT = koffi.struct("RECT", { left: "int32", top: "int32", right: "int32", bottom: "int32" });

const GetForegroundWindow = user32.func("intptr_t __stdcall GetForegroundWindow()");
const GetWindowThreadProcessId = user32.func("uint32 __stdcall GetWindowThreadProcessId(intptr_t h, _Out_ uint32* pid)");
const GetWindowRect = user32.func("bool __stdcall GetWindowRect(intptr_t h, _Out_ RECT* r)");
const IsIconic = user32.func("bool __stdcall IsIconic(intptr_t h)");

/** {hwnd, pid, rect} активного окна (rect — физические пиксели), либо null. */
function foreground() {
  const hwnd = GetForegroundWindow();
  if (!hwnd || IsIconic(hwnd)) return null;
  const out = [0];
  GetWindowThreadProcessId(hwnd, out);
  const r = {};
  if (!GetWindowRect(hwnd, r)) return null;
  return { hwnd, pid: out[0], rect: { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top } };
}

module.exports = { foreground };
