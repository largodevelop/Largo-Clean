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
      ? h("span", {}, h("b", {}, `${unused.length} ${plural(unused.length, "приложение", "приложения", "приложений")}`), ` не запускались больше ${UNUSED_DAYS} дней. Удалите то, что не нужно, — для игр Steam сохранения обычно остаются в облаке.`)
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
}
$("btn-update").onclick = () => api.installUpdate();
api.onUpdateChanged(setUpdate);
api.getUpdate().then(setUpdate).catch(() => {});

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
