"use strict";

// Отрисовка оверлея — общая для окна поверх игры и превью стилей в настройках.
(function () {
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const n0 = (v) => (v == null ? "—" : String(Math.round(v)));
const n1 = (v) => (v == null ? "—" : (Math.round(v * 10) / 10).toString().replace(".", ","));

// Группы показателей: [метка, [{ключ, значение, класс}]]
function groups(s, hw, fps) {
  const m = s.metrics;
  const g = [];
  const gpu = hw && hw.gpu, cpu = hw && hw.cpu, ram = hw && hw.ram;
  const hot = (t) => (t != null && t >= 80 ? "lo-hot" : "");
  if (m.fps || m.frametime || m.low1) {
    const v = [];
    if (m.fps) v.push({ t: n0(fps.fps), c: "lo-accent", u: " FPS" });
    if (m.frametime) v.push({ t: n1(fps.frametime), u: " ms" });
    if (m.low1) v.push({ t: n0(fps.low1), u: " 1%" });
    g.push(["FPS", v]);
  }
  if (gpu && (m.gpuLoad || m.gpuTemp || m.gpuClock || m.gpuPower || m.vram)) {
    const v = [];
    if (m.gpuLoad) v.push({ t: n0(gpu.load), u: "%" });
    if (m.gpuTemp) v.push({ t: n0(gpu.temp), u: "°", c: hot(gpu.temp) });
    if (m.gpuClock) v.push({ t: n0(gpu.clock), u: " MHz" });
    if (m.gpuPower) v.push({ t: n0(gpu.power), u: " W" });
    if (m.vram) {
      const used = n1(gpu.memUsed != null ? gpu.memUsed / 1024 : null);
      v.push({ t: gpu.memTotal ? `${used}/${n0(gpu.memTotal / 1024)}` : used, u: " GB" });
    }
    g.push(["GPU", v]);
  }
  if (cpu && (m.cpuLoad || m.cpuTemp || m.cpuClock)) {
    const v = [];
    if (m.cpuLoad) v.push({ t: n0(cpu.load), u: "%" });
    if (m.cpuTemp) v.push({ t: n0(cpu.temp), u: "°", c: hot(cpu.temp) });
    if (m.cpuClock) v.push({ t: n0(cpu.clock), u: " MHz" });
    g.push(["CPU", v]);
  }
  if (ram && m.ram) g.push(["RAM", [{ t: n1(ram.used), u: " GB" }]]);
  if (m.time) {
    const d = new Date();
    g.push(["", [{ t: d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) }]]);
  }
  return g;
}

function value(v) {
  const span = el("span", v.c || "");
  span.append(v.t);
  if (v.u) span.append(el("span", "lo-dim", v.u));
  return span;
}

function graph(fps, w, h) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  const data = (fps.graph || []).slice(-80);
  if (data.length > 1) {
    const max = Math.max(33, ...data);
    const pts = data.map((v, i) => `${((i / (data.length - 1)) * w).toFixed(1)},${(h - (v / max) * (h - 2) - 1).toFixed(1)}`).join(" ");
    const line = document.createElementNS(ns, "polyline");
    line.setAttribute("points", pts);
    line.setAttribute("fill", "none");
    line.setAttribute("stroke", "#67d4f0");
    line.setAttribute("stroke-width", "1.5");
    svg.append(line);
  }
  return svg;
}

function build({ settings: s, hw, fps }) {
  const bg = `rgba(10,10,12,${(s.bg / 100).toFixed(2)})`;
  const gs = groups(s, hw, fps);
  const out = [];

  if (s.style === 1) {
    const line = el("div", "lo-line lo-shadow");
    gs.forEach(([label, vals], i) => {
      if (i) line.append(el("span", "lo-dim", " · "));
      if (label && label !== "FPS") line.append(el("span", "lo-dim", label + " "));
      vals.forEach((v, j) => {
        if (j) line.append(" ");
        line.append(value(v));
      });
    });
    if (s.bg > 0) line.style.background = bg, line.style.borderRadius = "6px", line.style.padding = "4px 8px";
    out.push(line);
  } else if (s.style === 2 || s.style === 4) {
    const box = el("div", "lo-box");
    box.style.background = bg;
    if (s.style === 4) {
      const head = el("div", "lo-row");
      head.append(value({ t: n0(fps.fps), c: "lo-accent", u: " FPS" }), value({ t: n1(fps.frametime), u: " ms" }));
      head.style.fontWeight = "700";
      box.append(head, graph(fps, 200, 34));
    } else if (s.metrics.graph) {
      box.append(graph(fps, 200, 28));
    }
    const grid = el("div", "lo-grid");
    for (let [label, vals] of gs) {
      if (s.style === 4 && label === "FPS") continue;
      grid.append(el("span", "lo-dim", label));
      if (label === "FPS") vals = vals.map((v) => ({ ...v, u: v.u === " FPS" ? "" : v.u }));
      grid.append(value(vals[0] || { t: "" }));
      const rest = el("span", "lo-r");
      vals.slice(1).forEach((v, j) => {
        if (j) rest.append(" ");
        rest.append(value(v));
      });
      grid.append(rest);
    }
    box.append(grid);
    out.push(box);
  } else if (s.style === 3) {
    const pills = el("div", "lo-pills");
    for (const [label, vals] of gs) {
      const p = el("span", "lo-pill");
      p.style.background = bg === "rgba(10,10,12,0.00)" ? "rgba(10,10,12,.6)" : bg;
      if (label && label !== "FPS") p.append(el("span", "lo-dim", label + " "));
      vals.forEach((v, j) => {
        if (j) p.append(el("span", "lo-dim", " · "));
        p.append(value(v));
      });
      pills.append(p);
    }
    out.push(pills);
  } else {
    const wrap = el("div", "lo-shadow");
    if (s.bg > 0) wrap.style.background = bg, wrap.style.padding = "6px 10px", wrap.style.borderRadius = "8px";
    wrap.append(el("div", "lo-big lo-accent", n0(fps.fps)));
    wrap.append(el("div", "lo-small", `${n1(fps.frametime)} ms · 1% low ${n0(fps.low1)}`));
    out.push(wrap);
  }

  return out;
}

window.LargoOverlay = { build };
})();
