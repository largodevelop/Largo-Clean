"use strict";

const api = window.largo;
const $ = (id) => document.getElementById(id);
const SEP = "\\";

// ---------- утилиты ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
function svg(markup) {
  const t = document.createElement("template");
  t.innerHTML = markup.trim();
  return t.content.firstChild;
}
const ICON_REVEAL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true"><path d="M2 4.5c0-.6.4-1 1-1h3.3l1.4 1.5H13c.6 0 1 .4 1 1V12c0 .6-.4 1-1 1H3c-.6 0-1-.4-1-1V4.5Z"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 6.2 5 8.5l4.5-5"/></svg>';

const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
function fmtBytes(b) {
  if (!b || b < 0) return "0 Б";
  const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return (i >= 2 && b < 100 ? nf1.format(b) : nf0.format(b)) + " " + u[i];
}
function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}
function ago(ms) {
  if (!ms) return null;
  const days = Math.floor((Date.now() - ms) / 864e5);
  if (days <= 0) return "сегодня";
  if (days === 1) return "вчера";
  if (days < 30) return `${days} ${plural(days, "день", "дня", "дней")} назад`;
  const months = Math.floor(days / 30.4);
  if (months < 12) return `${months} ${plural(months, "месяц", "месяца", "месяцев")} назад`;
  const years = Math.floor(days / 365);
  return `${years} ${plural(years, "год", "года", "лет")} назад`;
}
function baseName(p) {
  const s = p.replace(/\\+$/, "");
  return s.slice(s.lastIndexOf(SEP) + 1) || p;
}
function parentOf(p) {
  const s = p.replace(/\\+$/, "");
  const i = s.lastIndexOf(SEP);
  if (i < 0) return null;
  const par = s.slice(0, i);
  return /^[a-z]:$/i.test(par) ? par + SEP : par;
}

let toastTimer = null;
function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3600);
}

function confirmModal({ title, text, ok = "Удалить", danger = true }) {
  return new Promise((resolve) => {
    $("modal-title").textContent = title;
    $("modal-text").textContent = text;
    const okBtn = $("modal-ok");
    okBtn.textContent = ok;
    okBtn.className = "btn " + (danger ? "btn-danger" : "btn-accent");
    $("modal").hidden = false;
    okBtn.focus();
    const done = (v) => {
      $("modal").hidden = true;
      okBtn.onclick = null;
      $("modal-cancel").onclick = null;
      document.removeEventListener("keydown", onKey);
      resolve(v);
    };
    const onKey = (e) => e.key === "Escape" && done(false);
    document.addEventListener("keydown", onKey);
    okBtn.onclick = () => done(true);
    $("modal-cancel").onclick = () => done(false);
  });
}

// ---------- состояние ----------
const state = {
  info: null,
  drive: "C:",
  scan: null, // результат сканирования
  scanning: false,
  children: new Map(),
  bySize: new Map(),
  treePath: null,
  targets: [],
  sizes: {},
  selected: new Set(),
  cleaning: false,
  apps: [],
  appsLoaded: false,
  appsFilter: "unused",
  appsSort: "size",
  showSystem: false,
};

const CATS = [
  ["games", "Игры"],
  ["programs", "Программы"],
  ["appdata", "Данные программ"],
  ["user", "Ваши файлы"],
  ["system", "Система"],
  ["temp", "Временное и кэш"],
  ["other", "Прочее"],
];
const UNUSED_DAYS = 60;

// ---------- навигация ----------
function go(page) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.page === page));
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("is-active", p.id === "page-" + page));
  document.querySelector(".content").scrollTop = 0;
  if (page === "overlay") updatePreviews();
  if (page === "apps" && !state.appsLoaded) loadApps();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => go(b.dataset.page)));
document.querySelectorAll("[data-goto]").forEach((b) => b.addEventListener("click", () => go(b.dataset.goto)));

// ---------- окно ----------
$("btn-min").onclick = () => api.minimize();
$("btn-max").onclick = () => api.maximize();
$("btn-close").onclick = () => api.close();

function renderAdmin() {
  const chip = $("admin-chip");
  chip.hidden = false;
  if (state.info.admin) {
    chip.textContent = "администратор";
    chip.classList.add("is-admin");
    chip.title = "Запущено с правами администратора";
    chip.onclick = null;
  } else {
    chip.textContent = "обычные права";
    chip.title = "Нажмите, чтобы перезапустить от администратора: нужно для очистки системных папок";
    chip.onclick = async () => {
      const r = await api.relaunchAdmin();
      if (!r.ok) toast(r.error);
    };
  }
}

function driveById(id) {
  return state.info.drives.find((d) => d.id === id);
}

function renderDrives() {
  const seg = $("drive-seg");
  seg.replaceChildren(
    ...state.info.drives.map((d) =>
      h("button", { type: "button", class: "seg-btn mono" + (d.id === state.drive ? " is-active" : ""), role: "tab", "aria-selected": String(d.id === state.drive), onclick: () => selectDrive(d.id) }, d.id)
    )
  );
  $("rail-drives").replaceChildren(
    ...state.info.drives.map((d) => {
      const used = d.size - d.free;
      const pct = d.size ? (used / d.size) * 100 : 0;
      return h(
        "div",
        { class: "drive-mini" },
        h("div", { class: "drive-mini-top" }, h("span", {}, d.id + (d.label ? " " + d.label : "")), h("span", {}, fmtBytes(d.free) + " своб.")),
        h("div", { class: "drive-mini-bar" }, h("i", { class: pct > 90 ? "is-full" : "", style: `width:${pct.toFixed(1)}%` }))
      );
    })
  );
}

function selectDrive(id) {
  if (state.scanning && id === state.drive) return;
  state.drive = id;
  renderDrives();
  startScan();
}

// ---------- обзор ----------
function renderHero() {
  const d = driveById(state.drive);
  if (!d) return;
  const used = d.size - d.free;
  $("ov-used").textContent = fmtBytes(used);
  $("ov-total").textContent = "из " + fmtBytes(d.size) + " · " + d.id + (d.label ? " " + d.label : "");
  $("ov-free").textContent = fmtBytes(d.free);

  const stack = $("ov-stack");
  const legend = $("ov-legend");
  if (!state.scan) {
    stack.replaceChildren(h("i", { class: "c-other", style: `flex:0 0 ${((used / d.size) * 100).toFixed(2)}%;opacity:.5` }));
    legend.replaceChildren();
    return;
  }
  const cats = state.scan.cats;
  const scanned = Object.values(cats).reduce((a, b) => a + b, 0);
  const hidden = Math.max(0, used - scanned);
  const parts = CATS.map(([k, name]) => ({ k, name, v: cats[k] || 0 })).filter((p) => p.v > 0);
  if (hidden > d.size * 0.003) parts.push({ k: "hidden", name: "Недоступно", v: hidden, hint: "Теневые копии, системные метаданные и папки без доступа" });
  stack.replaceChildren(...parts.map((p) => h("i", { class: "c-" + p.k, style: `flex:0 0 ${((p.v / d.size) * 100).toFixed(2)}%`, title: `${p.name}: ${fmtBytes(p.v)}` })));
  legend.replaceChildren(
    ...parts
      .sort((a, b) => b.v - a.v)
      .map((p) =>
        h(
          "div",
          { class: "legend-item", title: p.hint || "" },
          h("span", { class: "legend-dot c-" + p.k, style: p.k === "hidden" ? "background:#34343a" : "" }),
          h("span", { class: "legend-name" }, p.name),
          h("span", { class: "legend-val" }, fmtBytes(p.v))
        )
      ),
    h("div", { class: "legend-item" }, h("span", { class: "legend-dot c-free", style: "outline:1px solid #3a3a40" }), h("span", { class: "legend-name" }, "Свободно"), h("span", { class: "legend-val" }, fmtBytes(d.free)))
  );
}

function catOfPath(p) {
  // цвет полоски в дереве — по категории, в которую сканер отнёс папку (берём по крупным файлам/корню)
  const l = p.toLowerCase();
  if (/\\(steamapps|epic games|riot games|xboxgames)(\\|$)/.test(l)) return "games";
  if (/\\(temp|cache|dxcache|gpucache|code cache|npm-cache|shadercache|crashdumps)(\\|$)/.test(l) || l.endsWith("$recycle.bin")) return "temp";
  if (/^[a-z]:\\windows(\\|$)|system volume information|pagefile\.sys|hiberfil\.sys|swapfile\.sys/.test(l)) return "system";
  if (/\\appdata\\local\\programs(\\|$)|^[a-z]:\\program files/.test(l)) return "programs";
  if (/\\appdata(\\|$)|^[a-z]:\\programdata/.test(l)) return "appdata";
  if (/^[a-z]:\\users\\[^\\]+\\/.test(l)) return "user";
  return "other";
}

function indexScan(result) {
  state.children = new Map();
  state.bySize = new Map();
  for (const n of result.nodes) {
    state.bySize.set(n.p, n);
    if (n.d === 0) continue;
    const par = parentOf(n.p);
    if (!par) continue;
    if (!state.children.has(par)) state.children.set(par, []);
    state.children.get(par).push(n);
  }
  for (const list of state.children.values()) list.sort((a, b) => b.s - a.s);
}

function renderTree() {
  const rows = $("tree-rows");
  const crumbs = $("tree-crumbs");
  if (!state.scan) return;
  const cur = state.treePath || state.scan.root;
  const node = state.bySize.get(cur);
  const kids = state.children.get(cur) || [];

  // хлебные крошки
  const parts = [];
  let p = cur;
  while (p) {
    parts.unshift(p);
    if (p === state.scan.root) break;
    p = parentOf(p);
  }
  crumbs.replaceChildren(
    ...parts.flatMap((path, i) => [
      i > 0 ? h("span", { class: "crumb-sep" }, "›") : null,
      h("button", { type: "button", class: "crumb", onclick: i < parts.length - 1 ? () => openTree(path) : null }, i === 0 ? path.replace(/\\$/, "") : baseName(path)),
    ]).filter(Boolean)
  );

  if (!kids.length) {
    rows.replaceChildren(
      h("div", { class: "empty" }, node && node.d >= 5 ? "Глубже дерево не строится. Откройте папку в проводнике." : "Папка пуста или недоступна."),
      h("div", { style: "display:flex;justify-content:center;padding-bottom:12px" }, h("button", { type: "button", class: "btn btn-soft", onclick: () => api.open(cur) }, "Открыть в проводнике"))
    );
    return;
  }
  const max = kids[0].s || 1;
  const total = node ? node.s : kids.reduce((a, k) => a + k.s, 0);
  const shown = kids.slice(0, 60);
  const els = shown.map((k) => {
    const cat = catOfPath(k.p);
    const isDir = !k.leaf;
    const canOpen = isDir && state.children.has(k.p);
    const reveal = h("button", { type: "button", class: "icon-btn", "aria-label": "Показать в проводнике", title: "Показать в проводнике", onclick: (e) => (e.stopPropagation(), api.reveal(k.p)) }, svg(ICON_REVEAL));
    const pct = total ? (k.s / total) * 100 : 0;
    return h(
      canOpen ? "button" : "div",
      { type: canOpen ? "button" : null, class: "row", onclick: canOpen ? () => openTree(k.p) : null, title: k.p },
      h("span", { class: "row-name" }, h("span", { class: "dot c-" + cat }), h("span", { class: "row-title" + (canOpen ? " is-dir" : "") }, baseName(k.p))),
      h("span", { class: "row-bar", title: nf1.format(pct) + "%" }, h("i", { class: "c-" + cat, style: `width:${Math.max(1, (k.s / max) * 100).toFixed(1)}%` })),
      h("span", { class: "row-size" }, fmtBytes(k.s)),
      reveal
    );
  });
  if (kids.length > shown.length) {
    const rest = kids.slice(shown.length).reduce((a, k) => a + k.s, 0);
    els.push(h("div", { class: "row" }, h("span", { class: "row-name" }, h("span", { class: "row-title", style: "color:var(--text-muted)" }, `ещё ${kids.length - shown.length} элементов`)), h("span"), h("span", { class: "row-size", style: "color:var(--text-muted)" }, fmtBytes(rest)), h("span")));
  }
  rows.replaceChildren(...els);
  rows.scrollTop = 0;
}

function openTree(p) {
  state.treePath = p;
  renderTree();
}

function renderBigFiles() {
  const rows = $("big-rows");
  const list = (state.scan?.bigFiles || []).slice(0, 30);
  if (!list.length) {
    rows.replaceChildren(h("div", { class: "empty" }, "Файлов крупнее 256 МБ нет"));
    return;
  }
  rows.replaceChildren(
    ...list.map((f) =>
      h(
        "div",
        { class: "row big-row", title: f.p },
        h("span", { class: "row-name" }, h("span", { class: "row-title" }, baseName(f.p)), h("span", { class: "row-sub" }, parentOf(f.p) + (f.m ? " · " + new Date(f.m).toLocaleDateString("ru-RU") : ""))),
        h("span", { class: "row-size" }, fmtBytes(f.s)),
        h("button", { type: "button", class: "icon-btn", "aria-label": "Показать в проводнике", title: "Показать в проводнике", onclick: () => api.reveal(f.p) }, svg(ICON_REVEAL))
      )
    )
  );
}

function renderHibernation() {
  const hib = state.info.hibernation;
  const tile = $("tip-hib");
  tile.hidden = !(hib && hib.enabled && hib.size > 0);
  if (tile.hidden) return;
  $("tip-hib-num").textContent = fmtBytes(hib.size);
}

$("btn-hib").onclick = async () => {
  if (!state.info.admin) {
    const ok = await confirmModal({ title: "Нужны права администратора", text: "Отключить гибернацию можно только от администратора. Перезапустить Largo Clean с правами администратора?", ok: "Перезапустить", danger: false });
    if (ok) {
      const r = await api.relaunchAdmin();
      if (!r.ok) toast(r.error);
    }
    return;
  }
  const ok = await confirmModal({
    title: "Отключить гибернацию?",
    text: `Windows удалит hiberfil.sys и освободит ${fmtBytes(state.info.hibernation.size)}. Пропадут режим гибернации и «быстрый запуск»; обычный сон продолжит работать. Включить обратно: powercfg /h on.`,
    ok: "Отключить",
    danger: false,
  });
  if (!ok) return;
  const r = await api.hibernateOff();
  if (!r.ok) return toast(r.error);
  state.info.hibernation = r.hibernation;
  renderHibernation();
  toast("Гибернация отключена");
  refreshDrives();
};

$("btn-rescan").onclick = () => startScan();

async function startScan() {
  state.scanning = true;
  state.scan = null;
  state.treePath = null;
  $("btn-rescan").disabled = true;
  $("ov-scan").hidden = false;
  $("ov-scan-fill").style.width = "0";
  $("tree-rows").replaceChildren(h("div", { class: "empty" }, "Сканирую диск…"));
  $("big-rows").replaceChildren(h("div", { class: "empty" }, "Сканирую диск…"));
  $("tree-crumbs").replaceChildren();
  await refreshDrives();
  const drive = state.drive;
  const r = await api.scan(drive + SEP);
  if (drive !== state.drive) return; // за время скана выбрали другой диск
  state.scanning = false;
  $("btn-rescan").disabled = false;
  $("ov-scan").hidden = true;
  if (!r.ok) {
    if (!r.cancelled) $("tree-rows").replaceChildren(h("div", { class: "empty" }, "Не удалось просканировать: " + (r.error || "")));
    return;
  }
  state.info.drives = await api.drives(); // место могло измениться за время обхода
  renderDrives();
  state.scan = r.result;
  indexScan(r.result);
  renderHero();
  renderTree();
  renderBigFiles();
}

api.onScanProgress((p) => {
  const d = driveById(state.drive);
  const used = d ? d.size - d.free : 0;
  $("ov-scan-fill").style.width = used ? Math.min(100, (p.bytes / used) * 100).toFixed(1) + "%" : "0";
  $("ov-scan-count").textContent = `${nf0.format(p.files)} файлов · ${fmtBytes(p.bytes)}`;
  $("ov-scan-dir").textContent = p.dir;
});

async function refreshDrives() {
  state.info.drives = await api.drives();
  renderDrives();
  renderHero();
}

// ---------- очистка ----------
const GROUPS = [
  ["system", "Система"],
  ["gpu", "Видеокарта и игры"],
  ["apps", "Браузеры и приложения"],
  ["dev", "Разработка"],
  ["recycle", "Корзина"],
];

async function loadClean() {
  state.targets = await api.cleanTargets();
  state.selected = new Set(state.targets.filter((t) => t.on && (!t.admin || state.info.admin)).map((t) => t.id));
  state.sizes = {};
  renderClean();
  state.sizes = await api.cleanMeasure();
  renderClean();
}

function renderClean() {
  const wrap = $("clean-groups");
  wrap.replaceChildren(
    ...GROUPS.map(([g, title]) => {
      const items = state.targets.filter((t) => t.group === g);
      if (!items.length) return null;
      return h(
        "div",
        { class: "group" },
        h("div", { class: "group-title cap" }, title),
        h(
          "div",
          { class: "tile" },
          ...items.map((t) => {
            const size = state.sizes[t.id];
            const blocked = t.admin && !state.info.admin;
            const checked = state.selected.has(t.id) && !blocked;
            const toggle = () => {
              if (blocked || state.cleaning) return;
              if (state.selected.has(t.id)) state.selected.delete(t.id);
              else state.selected.add(t.id);
              renderClean();
            };
            return h(
              "div",
              {
                class: "clean-row" + (blocked ? " is-disabled" : ""),
                role: "checkbox",
                tabindex: blocked ? "-1" : "0",
                "aria-checked": String(checked),
                "aria-disabled": blocked ? "true" : null,
                onclick: toggle,
                onkeydown: (e) => (e.key === " " || e.key === "Enter") && (e.preventDefault(), toggle()),
              },
              h("span", { class: "box" }, svg(ICON_CHECK)),
              h("div", {}, h("div", { class: "clean-title" }, t.title), h("div", { class: "clean-desc" }, t.desc)),
              blocked
                ? h("button", { type: "button", class: "badge", style: "border:none;cursor:pointer", title: "Перезапустить от администратора", onclick: (e) => (e.stopPropagation(), api.relaunchAdmin().then((r) => !r.ok && toast(r.error))) }, "нужен администратор")
                : t.done != null
                  ? h("span", { class: "badge is-done" }, "−" + fmtBytes(t.done))
                  : h("span"),
              h(
                "span",
                { class: "clean-size" + (size == null ? " is-loading" : size.bytes === 0 ? " is-zero" : "") },
                size == null ? "считаю…" : fmtBytes(size.bytes)
              )
            );
          })
        )
      );
    })
  );
  const total = [...state.selected].reduce((a, id) => a + ((state.sizes[id] && state.sizes[id].bytes) || 0), 0);
  const measured = Object.keys(state.sizes).length > 0;
  $("clean-sum").textContent = measured ? fmtBytes(total) : "…";
  $("btn-clean").disabled = !measured || total === 0 || state.cleaning;
  const all = state.targets.filter((t) => !t.admin || state.info.admin).reduce((a, t) => a + ((state.sizes[t.id] && state.sizes[t.id].bytes) || 0), 0);
  const defaults = state.targets.filter((t) => t.on && (!t.admin || state.info.admin)).reduce((a, t) => a + ((state.sizes[t.id] && state.sizes[t.id].bytes) || 0), 0);
  $("tip-clean-num").textContent = measured ? fmtBytes(defaults) : "…";
  const badge = $("nav-clean-badge");
  badge.hidden = !measured || all === 0;
  badge.textContent = measured ? fmtBytes(defaults) : "";
}

$("btn-clean").onclick = async () => {
  const ids = [...state.selected];
  const total = ids.reduce((a, id) => a + ((state.sizes[id] && state.sizes[id].bytes) || 0), 0);
  const withBin = ids.includes("recycle");
  const ok = await confirmModal({
    title: `Очистить ${fmtBytes(total)}?`,
    text: "Файлы будут удалены без помещения в корзину. Занятые программами файлы пропускаются." + (withBin ? " Корзина будет очищена — восстановить её содержимое будет нельзя." : ""),
    ok: "Очистить",
  });
  if (!ok) return;
  state.cleaning = true;
  renderClean();
  const banner = $("clean-banner");
  banner.hidden = false;
  banner.className = "banner is-busy";
  banner.replaceChildren("Очищаю… ", h("b", { id: "clean-progress" }, "0 Б"));
  cleanProgress = {};
  const r = await api.clean(ids);
  state.cleaning = false;
  if (!r.ok) {
    banner.className = "banner";
    banner.replaceChildren("Ошибка очистки: " + r.error);
    return;
  }
  let freed = 0;
  let skipped = 0;
  for (const t of state.targets) {
    const res = r.res[t.id];
    if (!res) continue;
    t.done = res.bytes;
    freed += res.bytes;
    skipped += res.skipped || 0;
  }
  banner.className = "banner";
  banner.replaceChildren(
    "Освобождено ",
    h("b", {}, fmtBytes(freed)),
    skipped ? ` · пропущено ${nf0.format(skipped)} ${plural(skipped, "занятый файл", "занятых файла", "занятых файлов")}` : ""
  );
  state.sizes = await api.cleanMeasure();
  renderClean();
  refreshDrives();
};

let cleanProgress = {};
api.onCleanProgress((p) => {
  cleanProgress[p.id] = p.bytes;
  const el = $("clean-progress");
  if (el) el.textContent = fmtBytes(Object.values(cleanProgress).reduce((a, b) => a + b, 0));
});

// ---------- приложения ----------
function daysSince(ms) {
  return ms ? (Date.now() - ms) / 864e5 : Infinity;
}
function isUnused(a) {
  if (a.system) return false;
  if (a.kind === "steam") return a.neverUsed || daysSince(a.lastUsed) > UNUSED_DAYS;
  if (!a.lastUsed) return false; // нет данных — не значит «не пользуетесь»
  return daysSince(a.lastUsed) > UNUSED_DAYS;
}

async function loadApps() {
  state.appsLoaded = true;
  $("apps-rows").replaceChildren(h("div", { class: "empty", id: "apps-loading" }, "Собираю список установленных программ…"));
  const r = await api.apps();
  state.apps = r.apps;
  renderApps();
}

api.onAppsProgress((msg) => {
  const el = $("apps-loading");
  if (el) el.textContent = msg;
  $("apps-hero-text").textContent = msg;
});

function usageText(a) {
  if (a.kind === "steam" && a.neverUsed) return { text: "ни разу не запускалась", cls: "is-old" };
  if (!a.lastUsed) return { text: "нет данных", cls: "", title: "Windows не сохранила сведений о запусках этой программы" };
  const d = daysSince(a.lastUsed);
  const src = { steam: "по данным Steam", bam: "по журналу Windows", atime: "по времени доступа к exe-файлу (примерно)", prefetch: "по Prefetch", userassist: "по журналу Проводника" }[a.usageSource] || "";
  return { text: ago(a.lastUsed), cls: d <= 30 ? "is-recent" : d <= UNUSED_DAYS ? "is-mid" : "is-old", title: new Date(a.lastUsed).toLocaleString("ru-RU") + (src ? " · " + src : "") };
}

function filteredApps() {
  let list = state.apps.filter((a) => state.showSystem || !a.system);
  if (state.appsFilter === "unused") list = list.filter(isUnused);
  else if (state.appsFilter === "games") list = list.filter((a) => a.kind === "steam");
  if (state.appsSort === "size") list.sort((a, b) => b.size - a.size);
  else list.sort((a, b) => (a.lastUsed || (a.neverUsed ? -1 : 0)) - (b.lastUsed || (b.neverUsed ? -1 : 0)) || b.size - a.size);
  return list;
}

function renderApps() {
  const unused = state.apps.filter(isUnused);
  const unusedSize = unused.reduce((a, x) => a + x.size, 0);
  $("apps-hero-size").textContent = fmtBytes(unusedSize);
  const hero = $("apps-hero-text");
  hero.replaceChildren(
    unused.length
      ? h("span", {}, h("b", {}, `${unused.length} ${plural(unused.length, "приложение", "приложения", "приложений")}`), ` не запускались больше ${UNUSED_DAYS} дней.`)
      : h("span", {}, "Все программы, о которых есть данные, запускались за последние два месяца.")
  );
  $("tip-apps-num").textContent = unused.length ? fmtBytes(unusedSize) : "0";
  $("tip-apps-text").textContent = unused.length ? `${unused.length} ${plural(unused.length, "программа", "программы", "программ")} и игр не запускались больше ${UNUSED_DAYS} дней` : "Неиспользуемых программ не найдено";
  const badge = $("nav-apps-badge");
  badge.hidden = !unused.length;
  badge.textContent = String(unused.length);

  const list = filteredApps();
  const rows = $("apps-rows");
  if (!list.length) {
    rows.replaceChildren(h("div", { class: "empty" }, state.appsFilter === "unused" ? "Нечего предложить: всё используется" : "Ничего не найдено"));
    return;
  }
  rows.replaceChildren(
    ...list.map((a) => {
      const u = usageText(a);
      const icon = h("span", { class: "app-icon" + (a.kind === "steam" ? "" : " is-exe") }, h("span", {}, (a.name || "?").trim().charAt(0).toUpperCase()));
      if (a.iconFile) {
        api.icon(a.iconFile).then((url) => {
          if (url) icon.replaceChildren(h("img", { src: url, alt: "" }));
        });
      }
      const meta = [a.kind === "steam" ? "Steam" : a.publisher, a.version].filter(Boolean).join(" · ");
      return h(
        "div",
        { class: "row app-row", title: a.location || "" },
        icon,
        h("div", { style: "min-width:0" }, h("div", { class: "app-name" }, a.name), h("div", { class: "app-meta" }, meta || a.location || "")),
        h("span", { class: "app-used " + (u.cls === "is-old" ? "is-old" : ""), title: u.title || "" }, h("span", { class: "lamp " + u.cls }), u.text),
        h("span", { class: "row-size" }, a.size ? fmtBytes(a.size) : "—"),
        h("button", { type: "button", class: "btn btn-danger btn-row", onclick: () => uninstallApp(a) }, "Удалить")
      );
    })
  );
}

async function uninstallApp(a) {
  const ok = await confirmModal({
    title: `Удалить ${a.name}?`,
    text:
      a.kind === "steam"
        ? `Steam откроет окно удаления игры. Освободится около ${fmtBytes(a.size)}.`
        : `Запустится штатный деинсталлятор программы — следуйте его шагам.${a.size ? " Освободится около " + fmtBytes(a.size) + "." : ""} Когда закончите, обновите список.`,
    ok: "Удалить",
  });
  if (!ok) return;
  const r = await api.uninstall(a.id);
  if (!r.ok) toast(r.error);
  else toast(a.kind === "steam" ? "Открываю Steam…" : "Запускаю деинсталлятор…");
}

document.querySelectorAll("#apps-seg .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    state.appsFilter = b.dataset.filter;
    document.querySelectorAll("#apps-seg .seg-btn").forEach((x) => x.classList.toggle("is-active", x === b));
    renderApps();
  })
);
$("btn-apps-sort").onclick = () => {
  state.appsSort = state.appsSort === "size" ? "age" : "size";
  $("apps-sort-label").textContent = state.appsSort === "size" ? "По размеру" : "По давности";
  renderApps();
};
$("apps-system").onchange = (e) => {
  state.showSystem = e.target.checked;
  renderApps();
};
let lastAppsRefresh = 0;
window.addEventListener("focus", () => {
  // вернулись из деинсталлятора — тихо обновим список
  if (!state.appsLoaded || !document.querySelector("#page-apps.is-active") || Date.now() - lastAppsRefresh < 10000) return;
  lastAppsRefresh = Date.now();
  api.apps().then((r) => ((state.apps = r.apps), renderApps()));
});

// ---------- обновление ----------
function setUpdate(st) {
  if (!st) return;
  const btn = $("btn-update");
  btn.hidden = !st.available;
  const line = $("update-line");
  const known = typeof st.progress === "number";
  line.hidden = !st.updating;
  line.classList.toggle("is-indeterminate", st.updating && !known);
  $("update-line-fill").style.width = known ? `${Math.round(st.progress * 100)}%` : "";
  btn.classList.toggle("is-busy", Boolean(st.updating));
  const pct = known ? ` (${Math.round(st.progress * 100)}%)` : "";
  btn.title = st.updating ? `Скачиваю ${st.latest}${pct}` : st.available ? `Доступно обновление ${st.latest}: нажмите, чтобы установить` : "";
  if (st.error) toast("Обновление не удалось: " + st.error);
  if (st.updating && st.progress === 1) toast(`Устанавливаю ${st.latest} — Largo Clean откроется сам`);
}
$("btn-update").onclick = () => api.installUpdate();
api.onUpdateChanged(setUpdate);
api.getUpdate().then(setUpdate).catch(() => {});

// ---------- Monitor ----------
const HIST = 60;
const history = new Map();
function pushHist(key, v) {
  if (!history.has(key)) history.set(key, []);
  const a = history.get(key);
  a.push(v == null ? 0 : v);
  if (a.length > HIST) a.shift();
  return a;
}
function spark(values, color, max) {
  const top = max || Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (HIST - 1)) * 200).toFixed(1)},${(48 - (Math.min(v, top) / top) * 46).toFixed(1)}`).join(" ");
  return svg(`<svg class="mon-spark" viewBox="0 0 200 50" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`);
}
const fmt = {
  pct: (v) => (v == null ? "—" : nf0.format(v)),
  temp: (v) => (v == null ? "—" : nf0.format(v) + " °C"),
  ghz: (v) => (v == null || v === 0 ? "—" : nf1.format(v / 1000) + " ГГц"),
  mhz: (v) => (v == null || v === 0 ? "—" : nf0.format(v) + " МГц"),
  w: (v) => (v == null || v === 0 ? "—" : nf0.format(v) + " Вт"),
  gb: (v) => (v == null ? "—" : nf1.format(v) + " ГБ"),
  mbs: (v) => (v == null ? "—" : nf1.format(v / 1048576) + " МБ/с"),
  mbit: (v) => (v == null ? "—" : nf1.format((v * 8) / 1e6) + " Мбит/с"),
};

function monTile(t) {
  const hist = pushHist(t.key, t.raw);
  return h(
    "div",
    { class: "tile mon-tile" },
    h("div", { class: "mon-top" }, h("span", { class: "cap" }, t.cap), h("span", { class: "mono", title: t.model || "" }, t.model || "")),
    h("div", { class: "mon-val" }, h("span", { class: "big mono" }, t.value), h("span", { class: "unit" }, t.unit)),
    spark(hist, t.color, t.max),
    h(
      "div",
      { class: "mon-stats" },
      ...t.stats.map((s) => h("div", { class: "mon-stat" }, h("span", { class: "cap" }, s.k), h("span", { class: "mono" + (s.hot ? " is-hot" : "") }, s.v)))
    )
  );
}

function renderMonitor(x) {
  const tiles = [];
  if (x.cpu)
    tiles.push({
      key: "cpu", cap: "Процессор", model: x.cpu.name, value: fmt.pct(x.cpu.load), unit: "%", raw: x.cpu.load, max: 100, color: "var(--accent)",
      stats: [{ k: "темп.", v: fmt.temp(x.cpu.temp), hot: x.cpu.temp >= 80 }, { k: "частота", v: fmt.ghz(x.cpu.clock) }, { k: "питание", v: fmt.w(x.cpu.power) }],
    });
  if (x.gpu)
    tiles.push({
      key: "gpu", cap: "Видеокарта", model: x.gpu.name.replace(/^NVIDIA GeForce |^AMD Radeon /, ""), value: fmt.pct(x.gpu.load), unit: "%", raw: x.gpu.load, max: 100, color: "var(--c-programs)",
      stats: [
        { k: "темп.", v: fmt.temp(x.gpu.temp), hot: x.gpu.temp >= 80 },
        { k: "частота", v: fmt.mhz(x.gpu.clock) },
        { k: "видеопамять", v: x.gpu.memUsed != null ? `${nf1.format(x.gpu.memUsed / 1024)} / ${nf0.format((x.gpu.memTotal || 0) / 1024)} ГБ` : "—" },
      ],
    });
  if (x.ram && x.ram.used != null)
    tiles.push({
      key: "ram", cap: "Оперативная память", model: x.ram.total ? nf0.format(Math.round(x.ram.total)) + " ГБ" : "", value: fmt.pct(x.ram.load), unit: "%", raw: x.ram.load, max: 100, color: "var(--c-appdata)",
      stats: [{ k: "занято", v: fmt.gb(x.ram.used) }, { k: "свободно", v: fmt.gb(x.ram.total - x.ram.used) }],
    });
  x.disks.forEach((d, i) =>
    tiles.push({
      key: "disk" + i, cap: "Диск", model: d.name, value: fmt.pct(d.activity), unit: "%", raw: d.activity, max: 100, color: "var(--c-temp)",
      stats: [{ k: "чтение", v: fmt.mbs(d.read) }, { k: "запись", v: fmt.mbs(d.write) }, { k: "темп.", v: fmt.temp(d.temp), hot: d.temp >= 60 }],
    })
  );
  if (x.net && x.net.name)
    tiles.push({
      key: "net", cap: "Сеть", model: x.net.name, value: nf1.format((x.net.down * 8) / 1e6), unit: "Мбит/с", raw: x.net.down, color: "var(--c-user)",
      stats: [{ k: "приём", v: fmt.mbit(x.net.down) }, { k: "отдача", v: fmt.mbit(x.net.up) }],
    });
  $("mon-grid").replaceChildren(...tiles.map(monTile));
  $("pawnio-banner").hidden = Boolean(x.pawnio) || !x.admin;
  $("mon-meta").textContent = x.admin ? "обновление 1 с" : "без прав администратора: часть датчиков недоступна";
}

$("btn-pawnio").onclick = async () => {
  await api.installPawnio();
  toast("Открыт pawnio.eu — после установки драйвера датчики подключатся сами");
};
api.onPawnio(() => toast("PawnIO установлен — подключаю датчики платы"));

// ---------- Fan Speed ----------
const DEFAULT_CURVE = [[30, 25], [50, 35], [65, 55], [75, 75], [85, 100]];
const fanUi = { selected: null, draft: null, drag: -1, saved: {} };

function fanCfg(id) {
  return fanUi.saved[id] || { mode: "auto", pct: 50, sensor: null, curve: DEFAULT_CURVE };
}
function modeText(c) {
  if (c.mode === "manual") return `вручную · ${c.pct} %`;
  if (c.mode === "curve") return "кривая";
  return "авто";
}
function fanName(f) {
  if (f.hardware && /GPU|GeForce|Radeon/i.test(f.hardware)) return "Видеокарта " + f.hardware.replace(/^NVIDIA GeForce |^AMD Radeon /, "");
  return f.name
    .replace(/^CPU Fan/i, "Процессор")
    .replace(/^CPU Optional Fan/i, "Процессор, доп.")
    .replace(/^Pump Fan/i, "Помпа")
    .replace(/^System Fan/i, "Корпус")
    .replace(/^Fan/i, "Вентилятор");
}

function renderFans(x) {
  const list = $("fan-list");
  if (!x.fans.length) {
    list.replaceChildren(h("div", { class: "empty" }, x.pawnio ? "Управляемых вентиляторов не найдено" : "Вентиляторы платы видны после установки PawnIO"));
    $("fan-editor").hidden = true;
    return;
  }
  if (!fanUi.selected || !x.fans.some((f) => f.id === fanUi.selected)) selectFan(x.fans[0].id, x);
  list.replaceChildren(
    ...x.fans.map((f) =>
      h(
        "button",
        { type: "button", class: "fan-item" + (f.id === fanUi.selected ? " is-active" : ""), onclick: () => selectFan(f.id, x) },
        h("span", {}, h("b", {}, fanName(f)), h("small", {}, modeText(fanCfg(f.id)))),
        h("span", { class: "mono" }, f.rpm != null ? nf0.format(f.rpm) : "—")
      )
    )
  );
  const f = x.fans.find((v) => v.id === fanUi.selected);
  const src = x.temps.find((t) => t.id === fanUi.draft.sensor);
  $("fan-sub").textContent = `${f.rpm != null ? nf0.format(f.rpm) + " об/мин" : "—"} · ${f.pct != null ? nf0.format(f.pct) + " %" : "—"}${src ? " · " + src.name + " " + nf0.format(src.value) + " °C" : ""}${x.panic ? " · перегрев: 100 %" : ""}`;
  if (fanUi.draft.mode === "curve" && fanUi.drag < 0) drawCurve();
}

function selectFan(id, x) {
  fanUi.selected = id;
  const c = fanCfg(id);
  const temps = (x || state.hw)?.temps || [];
  const cpuTemp = temps.find((t) => /Tctl|Tdie|CPU Package/i.test(t.name));
  const gpuTemp = temps.find((t) => /GPU Core/i.test(t.name));
  const isGpu = /gpu/i.test(id);
  fanUi.draft = { mode: c.mode, pct: c.pct, sensor: c.sensor || (isGpu ? gpuTemp : cpuTemp || gpuTemp)?.id || null, curve: (c.curve || DEFAULT_CURVE).map((p) => p.slice()) };
  const f = (x || state.hw).fans.find((v) => v.id === id);
  $("fan-title").textContent = fanName(f);
  $("fan-editor").hidden = false;
  renderFanMode();
}

function renderFanMode() {
  const d = fanUi.draft;
  document.querySelectorAll("#fan-mode .seg-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.mode === d.mode));
  $("fan-manual").hidden = d.mode !== "manual";
  $("curve-wrap").hidden = d.mode !== "curve";
  $("fan-auto").hidden = d.mode !== "auto";
  $("fan-src").hidden = $("fan-src-cap").hidden = d.mode !== "curve";
  $("fan-slider").value = d.pct;
  $("fan-pct").textContent = d.pct + " %";
  if (d.mode === "curve") {
    drawCurve();
    renderSensorDd();
  }
}
document.querySelectorAll("#fan-mode .seg-btn").forEach((b) =>
  b.addEventListener("click", () => {
    fanUi.draft.mode = b.dataset.mode;
    renderFanMode();
  })
);
$("fan-slider").oninput = (e) => {
  fanUi.draft.pct = Number(e.target.value);
  $("fan-pct").textContent = fanUi.draft.pct + " %";
};
$("fan-apply").onclick = async () => {
  const cfg = { ...fanUi.draft, curve: fanUi.draft.curve.map((p) => [Math.round(p[0]), Math.round(p[1])]) };
  await api.setFan(fanUi.selected, cfg);
  if (cfg.mode === "auto") delete fanUi.saved[fanUi.selected];
  else fanUi.saved[fanUi.selected] = cfg;
  toast(cfg.mode === "auto" ? "Управление возвращено BIOS" : "Применено");
  if (state.hw) renderFans(state.hw);
};

// кривая: x — температура 20…100 °C, y — скорость 0…100 %
const CW = 640, CH = 360;
const tx = (t) => ((t - 20) / 80) * CW;
const py = (p) => CH - (p / 100) * CH;
function drawCurve() {
  const el = $("curve");
  const c = fanUi.draft.curve;
  const src = state.hw?.temps.find((t) => t.id === fanUi.draft.sensor);
  let s = "";
  for (let i = 1; i < 4; i++) s += `<path d="M0 ${(CH / 4) * i}H${CW}" stroke="rgba(255,255,255,.05)"/>`;
  for (let i = 1; i < 8; i++) s += `<path d="M${(CW / 8) * i} 0V${CH}" stroke="rgba(255,255,255,.05)"/>`;
  s += `<path d="M0 ${py(20)}H${CW}" stroke="rgba(255,107,107,.25)" stroke-dasharray="3 5"/>`;
  if (src) s += `<path d="M${tx(src.value)} 0V${CH}" stroke="#c4a574" stroke-dasharray="4 4"/>`;
  const pts = [[20, c[0][1]], ...c, [100, c[c.length - 1][1]]].map((p) => `${tx(p[0])},${py(p[1])}`).join(" ");
  s += `<polyline points="${pts}" fill="none" stroke="#67d4f0" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
  c.forEach((p, i) => (s += `<circle class="curve-pt" data-i="${i}" cx="${tx(p[0])}" cy="${py(p[1])}" r="8" fill="${fanUi.drag === i ? "#67d4f0" : "#0f0f0f"}" stroke="#67d4f0" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`));
  el.innerHTML = s;
}
(() => {
  const el = $("curve");
  const toData = (e) => {
    const r = el.getBoundingClientRect();
    const t = 20 + ((e.clientX - r.left) / r.width) * 80;
    const p = 100 - ((e.clientY - r.top) / r.height) * 100;
    return [t, p];
  };
  el.addEventListener("pointerdown", (e) => {
    const i = Number(e.target.dataset?.i);
    if (Number.isNaN(i)) return;
    fanUi.drag = i;
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener("pointermove", (e) => {
    if (fanUi.drag < 0) return;
    const c = fanUi.draft.curve;
    const i = fanUi.drag;
    let [t, p] = toData(e);
    const lo = i > 0 ? c[i - 1][0] + 2 : 20;
    const hi = i < c.length - 1 ? c[i + 1][0] - 2 : 100;
    t = Math.max(lo, Math.min(hi, t));
    p = Math.max(20, Math.min(100, p));
    c[i] = [t, p];
    drawCurve();
    const tip = $("curve-tip");
    tip.hidden = false;
    tip.textContent = `${Math.round(t)} °C → ${Math.round(p)} %`;
    const r = el.getBoundingClientRect();
    tip.style.left = e.clientX - r.left + "px";
    tip.style.top = e.clientY - r.top + "px";
  });
  const end = () => {
    fanUi.drag = -1;
    $("curve-tip").hidden = true;
    drawCurve();
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
})();

function renderSensorDd() {
  const dd = $("fan-src");
  const temps = state.hw?.temps || [];
  const cur = temps.find((t) => t.id === fanUi.draft.sensor);
  const chevron = '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5 6 7.5 9 4.5"/></svg>';
  const btn = h("button", { type: "button", class: "dd-btn", "aria-haspopup": "listbox" }, h("span", {}, cur ? cur.name : "самый горячий CPU/GPU"), svg(chevron));
  const pop = h(
    "div",
    { class: "dd-pop", role: "listbox", hidden: true },
    ...temps.map((t) =>
      h(
        "button",
        { type: "button", class: "dd-opt" + (t.id === fanUi.draft.sensor ? " is-active" : ""), role: "option", onclick: () => ((fanUi.draft.sensor = t.id), renderSensorDd(), drawCurve()) },
        h("span", {}, t.name),
        h("span", { class: "mono" }, nf0.format(t.value) + " °C")
      )
    )
  );
  btn.onclick = (e) => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
  };
  document.addEventListener("click", () => (pop.hidden = true), { once: true });
  dd.replaceChildren(btn, pop);
}

// ---------- Overlay ----------
const METRICS = [
  ["fps", "FPS"], ["frametime", "Время кадра"], ["low1", "1% low"], ["graph", "График кадров"],
  ["gpuLoad", "GPU %"], ["gpuTemp", "GPU °C"], ["gpuClock", "GPU МГц"], ["gpuPower", "GPU Вт"], ["vram", "VRAM"],
  ["cpuLoad", "CPU %"], ["cpuTemp", "CPU °C"], ["cpuClock", "CPU МГц"], ["ram", "RAM"], ["time", "Время"],
];
const STYLE_LABELS = ["1 · строка", "2 · таблица", "3 · пилюли", "4 · график", "5 · только FPS"];
let lastFps = null;

// Пока игра не запущена — показываем в превью правдоподобные кадры, остальное живое с датчиков
function previewFps() {
  if (lastFps && lastFps.game && lastFps.fps != null) return lastFps;
  const graph = Array.from({ length: 80 }, (_, i) => 6.9 + Math.sin(i * 0.7) * 0.4 + (i % 23 === 0 ? 5 : 0));
  return { fps: 144, frametime: 6.9, low1: 118, graph };
}

// Превью рисует тот же код, что и окно оверлея: выбранные показатели видны сразу
function updatePreviews() {
  const o = state.overlay;
  if (!o) return;
  document.querySelectorAll(".ovl-style").forEach((card) => {
    const style = Number(card.dataset.style);
    const box = card.querySelector(".lo");
    box.replaceChildren(...window.LargoOverlay.build({ settings: { ...o, style }, hw: state.hw, fps: previewFps() }));
  });
}

function renderOverlay() {
  const o = state.overlay;
  if (!o) return;
  $("ovl-enabled").setAttribute("aria-checked", String(o.enabled));
  $("nav-overlay-badge").hidden = !o.enabled;
  $("ovl-styles").replaceChildren(
    ...STYLE_LABELS.map((label, i) =>
      h(
        "button",
        { type: "button", class: "ovl-style" + (o.style === i + 1 ? " is-active" : ""), "data-style": String(i + 1), "aria-pressed": String(o.style === i + 1), onclick: () => setOverlay({ style: i + 1 }) },
        h("div", { class: "ovl-live" }, h("div", { class: "lo" })),
        h("span", { class: "lbl" }, label)
      )
    )
  );
  updatePreviews();
  $("ovl-metrics").replaceChildren(
    ...METRICS.map(([k, label]) => h("button", { type: "button", class: "chip-t", "aria-pressed": String(Boolean(o.metrics[k])), onclick: () => setOverlay({ metrics: { [k]: !o.metrics[k] } }) }, label))
  );
  $("ovl-corner").replaceChildren(
    ...[["tl", "Слева сверху"], ["tr", "Справа сверху"], ["bl", "Слева снизу"], ["br", "Справа снизу"]].map(([c, label]) =>
      h("button", { type: "button", class: "corner" + (o.corner === c ? " is-active" : ""), "data-c": c, "aria-label": label, title: label, onclick: () => setOverlay({ corner: c }) })
    )
  );
  $("ovl-scale").value = o.scale;
  $("ovl-scale-v").textContent = o.scale + " %";
  $("ovl-bg").value = o.bg;
  $("ovl-bg-v").textContent = o.bg + " %";
  $("ovl-only").checked = o.onlyGames;
  $("ovl-hotkey").value = o.hotkey || "нет";
}
async function setOverlay(patch) {
  state.overlay = await api.setOverlay(patch);
  renderOverlay();
}
$("ovl-enabled").onclick = () => setOverlay({ enabled: !state.overlay.enabled });
$("ovl-scale").oninput = (e) => setOverlay({ scale: Number(e.target.value) });
$("ovl-bg").oninput = (e) => setOverlay({ bg: Number(e.target.value) });
$("ovl-only").onchange = (e) => setOverlay({ onlyGames: e.target.checked });
$("ovl-hotkey").addEventListener("keydown", (e) => {
  e.preventDefault();
  if (e.key === "Backspace" || e.key === "Delete") return setOverlay({ hotkey: "" });
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
  const parts = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  const key = e.code.startsWith("Key") ? e.code.slice(3) : e.code.startsWith("Digit") ? e.code.slice(5) : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  parts.push(key);
  setOverlay({ hotkey: parts.join("+") });
  e.target.blur();
});
api.onOverlaySettings((o) => ((state.overlay = o), renderOverlay()));
api.onFps((f) => {
  lastFps = f;
  $("ov-fps-meta").textContent = f.fps != null ? `${f.app || "игра"} · ${f.fps} FPS` : f.error || "игра не найдена";
});

// ---------- поток датчиков ----------
api.onHwSample((x) => {
  state.hw = x;
  renderMonitor(x); // и в фоне: история графиков копится с запуска
  if (document.querySelector("#page-overlay.is-active")) updatePreviews();
  if (document.querySelector("#page-fans.is-active") || !fanUi.selected) renderFans(x);
});
(async () => {
  const s = await api.hwState();
  fanUi.saved = s.fans || {};
  state.overlay = s.overlay;
  renderOverlay();
  if (s.sample) {
    state.hw = s.sample;
    renderMonitor(s.sample);
    renderFans(s.sample);
  }
})();

// ---------- старт ----------
(async () => {
  state.info = await api.info();
  $("app-ver").textContent = "v" + state.info.version;
  if (!driveById(state.drive) && state.info.drives[0]) state.drive = state.info.drives[0].id;
  renderAdmin();
  renderDrives();
  renderHero();
  renderHibernation();
  startScan();
  loadClean();
  loadApps();
})();
