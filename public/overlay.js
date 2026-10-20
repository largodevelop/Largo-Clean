"use strict";

// Окно оверлея поверх игры: отрисовка в overlay-render.js, здесь масштаб и размер окна.
const root = document.getElementById("root");

window.overlay.onData((data) => {
  root.replaceChildren(...window.LargoOverlay.build(data));
  const k = Math.max(0.5, Math.min(2, data.settings.scale / 100));
  root.style.transform = `scale(${k})`;
  const r = root.getBoundingClientRect();
  window.overlay.size(r.width + 2, r.height + 2);
});
