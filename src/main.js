const { invoke } = window.__TAURI__.core;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
// ComicVine descriptions are HTML; reduce to inert plain text.
const txt = (h) => new DOMParser().parseFromString((h || "").replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, " "), "text/html").body.textContent.replace(/\s+/g, " ").trim();
const img = (u) => (u ? `<img loading="lazy" src="${esc(u)}" alt="">` : `<div class="ph"></div>`);
const num = (x) => (x ?? 0).toLocaleString();
const PAGE = 50;
const MAX = 500; // most series shown in the results list
let curNav = null; // prev/next ids while an issue is on screen
// Comic Vine issue ids are prefixed with the resource type 4000 (4005 is characters).
const CV_ISSUE_PREFIX = 4000;
const cvid = (id) => `${CV_ISSUE_PREFIX}-${id}`;
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); }
  catch { const a = document.createElement("textarea"); a.value = t; document.body.append(a); a.select(); document.execCommand("copy"); a.remove(); }
}
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cv]");
  if (!b) return;
  if (!b.dataset.label) b.dataset.label = b.textContent;
  await copyText(b.dataset.cv);
  b.textContent = "Copied ✓";
  setTimeout(() => (b.textContent = b.dataset.label), 1200);
});
let view = "volumes", offset = 0, timer;
// Multi-select dropdown (checkbox list + filter box) used in the filter panel.
function multi(sel, noun, plural) {
  const root = $(sel), set = new Set();
  let items = [];
  root.insertAdjacentHTML("beforeend", `<div class="panel"><input placeholder="Filter ${plural}…"><div class="list"></div><button>Clear selection</button></div>`);
  const box = root.querySelector("input"), list = root.querySelector(".list"), clear = root.querySelector("button");
  const label = () => (root.querySelector("summary").textContent = set.size ? `${set.size} ${set.size > 1 ? plural : noun} selected` : `All ${plural}`);
  const render = () => {
    const f = box.value.toLowerCase();
    const row = (x) => `<label><input type="checkbox" value="${esc(x.key)}" ${set.has(x.key) ? "checked" : ""}> ${esc(x.name)} <span class="muted">(${x.n})</span></label>`;
    const vis = items.filter((x) => String(x.name).toLowerCase().includes(f));
    const pin = vis.filter((x) => x.pin), rest = vis.filter((x) => !x.pin);
    list.innerHTML = pin.map(row).join("") + (pin.length && rest.length ? "<hr>" : "") + rest.map(row).join("");
    label();
  };
  const changed = () => { offset = 0; load(); };
  box.oninput = render;
  list.onchange = (e) => {
    const it = items.find((x) => String(x.key) === e.target.value);
    if (it) e.target.checked ? set.add(it.key) : set.delete(it.key);
    label();
    changed();
  };
  clear.onclick = () => { set.clear(); box.value = ""; render(); changed(); }; // also empties the filter box
  document.addEventListener("click", (e) => { if (!root.contains(e.target)) root.open = false; });
  const defaults = () => items.filter((x) => x.pin).map((x) => x.key);
  const reset = () => { set.clear(); defaults().forEach((k) => set.add(k)); box.value = ""; render(); };
  return {
    set,
    setItems(a) { items = a; reset(); }, // new data starts at the defaults (pinned items)
    reset,
    isDefault() { const d = defaults(); return set.size === d.length && d.every((k) => set.has(k)); },
  };
}
const pubM = multi("#pub", "publisher", "publishers");
const yrM = multi("#yr", "year", "years");
const iyM = multi("#iyr", "year", "years");

// Credit columns are usually JSON arrays of {name,...}; fall back to raw text.
function chips(t) {
  if (!t) return "";
  try {
    const a = JSON.parse(t);
    if (Array.isArray(a)) return a.map((x) => `<span class="chip">${esc(typeof x === "object" ? x.name : x)}</span>`).join("");
  } catch {}
  return `<p>${esc(t)}</p>`;
}
const sec = (h, t) => (t ? `<h4>${h}</h4><div>${chips(t)}</div>` : "");

async function load() {
  const q = $("#q").value;
  const nf = [pubM, yrM, iyM].filter((f) => f.set.size).length; // filter groups in use
  $("#fclear").disabled = [pubM, yrM, iyM].every((f) => f.isDefault());
  $("#ftoggle").textContent = nf ? `☰ Filters (${nf})` : "☰ Filters";
  try {
    let rows, html, more = false;
    if (view === "volumes") {
      rows = await invoke("search_volumes", { q, publishers: [...pubM.set], years: [...yrM.set], issueYears: [...iyM.set] });
      more = rows.length > MAX;
      if (more) rows = rows.slice(0, MAX);
      html = rows.map((v) => `<div class="row" data-v="${v.id}">${img(v.image_url)}<div><b>${esc(v.name)}</b><small>${esc(v.publisher)} · ${esc(v.start_year)} · ${v.count_of_issues ?? "?"} issues</small></div></div>`).join("");
    } else {
      rows = await invoke("list_files", { q, filter: $("#flt").value, offset });
      html = rows.map((f) => `<div class="row" ${f.cvid ? `data-i="${f.cvid}"` : ""}><div><b>${esc(f.filename)}</b><small>${f.cvid ? esc(f.volume) + " #" + esc(f.issue_number) : "unmatched"} · ${((f.file_size || 0) / 1048576).toFixed(1)} MB</small></div></div>`).join("");
    }
    $("#rows").innerHTML = html || `<p class="muted" style="padding:10px">No results</p>`;
    $("#pg").textContent = view === "volumes"
      ? (more ? `Showing the first ${MAX} series — narrow your search` : `${rows.length} series`)
      : rows.length ? `${offset + 1}–${offset + rows.length}` : "";
    $("#prev").hidden = $("#next").hidden = view === "volumes";
    $("#prev").disabled = offset === 0;
    $("#next").disabled = rows.length < PAGE;
  } catch (e) {
    $("#rows").innerHTML = `<p class="err">${esc(e)}</p>`;
  }
}

// ---- Issue-number filter for a series' issue list.
// Terms are separated by commas or spaces: "5", "1-n" (a range), "n" (last issue), "annual" (text match).
let curIssues = [];
function parseIssueFilter(text) {
  const t = text.trim().toLowerCase().replace(/\s*-\s*/g, "-");
  const terms = t.split(/[\s,]+/).filter(Boolean).map((term) => {
    const r = term.match(/^([\d.]+|n)-([\d.]+|n)$/);
    return r ? { a: r[1], b: r[2] } : { s: term };
  });
  return terms.length ? terms : null;
}
function issueMatches(num, terms, last) {
  const x = parseFloat(num), v = (s) => (s === "n" ? last : parseFloat(s));
  return terms.some((t) => {
    if (t.s === undefined) {
      const a = v(t.a), b = v(t.b);
      return Number.isFinite(x) && x >= Math.min(a, b) && x <= Math.max(a, b);
    }
    if (t.s === "n") return x === last;
    if (/^[\d.]+$/.test(t.s)) return x === parseFloat(t.s);
    return String(num ?? "").toLowerCase().includes(t.s);
  });
}
const issueRow = (i) => `<tr class="link" data-i="${i.id}"><td>${img(i.image_url)}</td><td>#${esc(i.issue_number)}</td><td>${esc(i.name)}</td><td class="muted">${esc(i.cover_date)}</td><td class="badge">${i.files ? i.files + " file" + (i.files > 1 ? "s" : "") : ""}</td><td><button class="copy" data-cv="${cvid(i.id)}" title="Copy CVID">CVID</button></td></tr>`;
function renderIssues() {
  const terms = parseIssueFilter($("#inum").value);
  const nums = curIssues.map((i) => parseFloat(i.issue_number)).filter(Number.isFinite);
  const last = nums.length ? Math.max(...nums) : NaN;
  const rows = terms ? curIssues.filter((i) => issueMatches(i.issue_number, terms, last)) : curIssues;
  $("#itbl").innerHTML = rows.map(issueRow).join("");
  $("#icount").textContent = terms ? `${rows.length} of ${curIssues.length}` : `${curIssues.length} issues`;
}

async function showVolume(id) {
  const d = await invoke("get_volume", { id: +id });
  const v = d.volume;
  if (!v) return;
  curNav = null;
  $("#detail").innerHTML = `
    <div class="hd">${img(v.image_url)}<div>
      <h2>${esc(v.name)}</h2>
      <div class="muted">${esc(v.publisher)} · ${esc(v.start_year)} · ${v.count_of_issues ?? "?"} issues · <code>id ${v.id}</code></div>
      ${v.aliases ? `<p class="muted">Aliases: ${esc(v.aliases.replace(/\n/g, ", "))}</p>` : ""}
      <p>${esc(txt(v.description).slice(0, 700))}</p>
    </div></div>
    <div class="bar" style="margin:8px 0"><input id="inum" placeholder="Issue # — e.g. 5, 1-10, 1-n, 1,3,5" style="flex:1"><span id="icount" class="muted"></span></div>
    <table id="itbl"></table>`;
  curIssues = d.issues;
  renderIssues();
  $("#inum").oninput = renderIssues;
  $("#detail").onclick = (e) => { if (e.target.closest("[data-cv]")) return; const r = e.target.closest("tr[data-i]"); if (r) showIssue(r.dataset.i); };
}

async function showIssue(id) {
  const d = await invoke("get_issue", { id: +id });
  const i = d.issue;
  if (!i) return;
  const n = d.nav;
  // Prefer the URL stored in the database; otherwise build the standard issue URL.
  const cvUrl = /^https?:\/\//.test(i.site_detail_url || "") ? i.site_detail_url : `https://comicvine.gamespot.com/issue/${cvid(i.id)}/`;
  curNav = n;
  $("#detail").scrollTop = 0;
  let extra = "";
  try { extra = JSON.parse(i.associated_images || "[]").map((x) => img(x.original_url || x.url || x.thumb_url)).join(""); } catch {}
  $("#detail").innerHTML = `
    <div class="bar"><button onclick="showVolume(${i.volume_id})">← ${esc(i.volume_name)}</button><span class="sp"></span>
      <button ${n.prev ? `onclick="showIssue(${n.prev})"` : "disabled"} title="Previous issue (←)">◀</button>
      <span class="muted">${n.pos ?? "?"} / ${n.total}</span>
      <button ${n.next ? `onclick="showIssue(${n.next})"` : "disabled"} title="Next issue (→)">▶</button></div>
    <div class="hd" style="margin-top:12px">${img(i.image_url)}<div>
      <h2>${esc(i.volume_name)} #${esc(i.issue_number)}</h2>
      <div class="muted">${esc(i.name)} · ${esc(i.publisher)} · cover ${esc(i.cover_date)} · store ${esc(i.store_date)} · <code>${cvid(i.id)}</code> <button class="copy" data-cv="${cvid(i.id)}">Copy CVID</button> <button class="copy" data-url="${esc(cvUrl)}">Open ComicVine</button></div>
      <p>${esc(txt(i.description).slice(0, 900))}</p>
    </div></div>
    ${sec("Characters", i.character_credits)}${sec("People", i.person_credits)}${sec("Teams", i.team_credits)}${sec("Locations", i.location_credits)}${sec("Story arcs", i.story_arc_credits)}
    ${extra ? `<h4>Associated images</h4><div class="gallery">${extra}</div>` : ""}`;
}

// Featured publishers first (in this order), then the rest alphabetically.
const FEATURED = [
  /^boom!?\s*studios?$/i,
  /^dark horse( comics)?$/i,
  /^dc( comics)?$/i,
  /^dynamite( entertainment)?$/i,
  /^idw( publishing)?$/i,
  /^image( comics)?$/i,
  /^marvel( comics)?$/i,
];
function pubItems(list) {
  const items = list.map((p) => {
    const r = FEATURED.findIndex((re) => re.test((p.name || "").trim()));
    return { key: p.id, name: p.name || "", n: p.volumes, pin: r >= 0, r };
  });
  const az = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  return items.sort((a, b) => (a.pin !== b.pin ? (a.pin ? -1 : 1) : a.pin ? a.r - b.r || az(a, b) : az(a, b)));
}

async function openDb(path) {
  try {
    const r = await invoke("open_db", { path });
    const s = r.stats;
    $("#stats").textContent = `${num(s.publishers)} publishers · ${num(s.volumes)} series · ${num(s.issues)} issues · ${num(s.files)} files (${num(s.matched)} matched)`;
    pubM.setItems(pubItems(await invoke("list_publishers")));
    yrM.setItems((await invoke("list_years")).map((y) => ({ key: y.year, name: y.year, n: y.n })));
    iyM.setItems((await invoke("list_issue_years")).map((y) => ({ key: y.year, name: y.year, n: y.n })));
    offset = 0;
    curNav = null;
    $("#detail").innerHTML = `<p class="muted">Select a series.</p>`;
    dbOpen = true;
    load();
    try { await invoke("save_db_path", { path }); } catch {} // remember as the default
    return true;
  } catch (e) {
    if (dbOpen) await window.__TAURI__.dialog.message(String(e), { title: "Couldn’t open database", kind: "error" });
    else $("#rows").innerHTML = `<p class="err">${esc(e)}</p>`;
    return false;
  }
}

let dbOpen = false;
// Standard file dialog; a successfully opened file becomes the saved default.
async function chooseDb() {
  const p = await window.__TAURI__.dialog.open({
    title: "Select the ComicVine database",
    multiple: false,
    directory: false,
    filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3"] }, { name: "All files", extensions: ["*"] }],
  });
  if (p) await openDb(p);
  else if (!dbOpen && !$("#rows").innerHTML.trim()) $("#rows").innerHTML = `<p class="muted" style="padding:10px">No database selected. Click “Open DB…” to choose one.</p>`;
}

document.querySelectorAll("nav button").forEach((b) => (b.onclick = () => {
  view = b.dataset.view;
  document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
  $("#fseries").hidden = view !== "volumes";
  $("#fnote").hidden = view === "volumes";
  $("#flt").hidden = view !== "files";
  offset = 0;
  load();
}));
$("#rows").onclick = (e) => {
  const r = e.target.closest(".row");
  if (!r) return;
  if (r.dataset.v) showVolume(r.dataset.v); else if (r.dataset.i) showIssue(r.dataset.i);
};
$("#q").oninput = () => { clearTimeout(timer); timer = setTimeout(() => { offset = 0; load(); }, 250); };
$("#flt").onchange = () => { offset = 0; load(); };
$("#prev").onclick = () => { offset = Math.max(0, offset - PAGE); load(); };
$("#next").onclick = () => { offset += PAGE; load(); };
$("#open").onclick = chooseDb;

(async () => {
  const saved = await invoke("saved_db_path");
  if (saved && (await openDb(saved))) return;
  await chooseDb();
})();

// ---- Image pop-up: click any thumbnail to see a larger version.
// Comic Vine serves sizes by path (/uploads/scale_small/...); try the original, fall back to what we have.
const bigUrl = (u) => u.replace(/\/uploads\/[a-z_]+\//, "/uploads/original/");
function zoom(src) {
  const im = $("#lb img");
  im.onerror = () => { im.onerror = null; im.src = src; };
  im.src = bigUrl(src);
  $("#lb").hidden = false;
}
// Capture phase so a thumbnail click doesn't also open the row underneath it.
document.addEventListener("click", (e) => {
  const im = e.target.closest("img");
  if (!im || im.closest("#lb")) return;
  e.preventDefault();
  e.stopPropagation();
  zoom(im.src);
}, true);
$("#lb").onclick = () => { $("#lb").hidden = true; $("#lb img").removeAttribute("src"); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#lb").click(); });

// Left/right arrow keys step through issues (ignored while typing or when the pop-up is open).
document.addEventListener("keydown", (e) => {
  if (!curNav || !$("#lb").hidden || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName)) return;
  const id = e.key === "ArrowLeft" ? curNav.prev : e.key === "ArrowRight" ? curNav.next : null;
  if (id) showIssue(id);
});

// Show/hide the filter panel (remembered between launches).
try { document.body.classList.toggle("nofilters", localStorage.getItem("cv-filters-hidden") === "1"); } catch {}
$("#ftoggle").onclick = () => {
  const hidden = document.body.classList.toggle("nofilters");
  try { localStorage.setItem("cv-filters-hidden", hidden ? "1" : "0"); } catch {}
};

// "Clear all" resets the panel: publishers back to the pinned ones, years cleared (the search box is left alone).
$("#fclear").onclick = () => { pubM.reset(); yrM.reset(); iyM.reset(); offset = 0; load(); };

// "Open ComicVine" opens the page in the default browser.
document.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-url]");
  if (!b) return;
  try { await invoke("plugin:opener|open_url", { url: b.dataset.url }); }
  catch { b.textContent = "Couldn’t open"; setTimeout(() => (b.textContent = "Open ComicVine"), 1500); }
});

// ---- Theme: light/dark toggle in the header; follows the OS until the user picks one.
const savedTheme = () => { try { return localStorage.getItem("cv-theme"); } catch { return null; } };
function setTheme(t, save) {
  document.documentElement.dataset.theme = t;
  $("#theme").textContent = t === "dark" ? "☀ Light" : "☾ Dark";
  if (save) { try { localStorage.setItem("cv-theme", t); } catch {} }
}
const osLight = matchMedia("(prefers-color-scheme: light)");
setTheme(savedTheme() || (osLight.matches ? "light" : "dark"), false);
osLight.addEventListener("change", (e) => { if (!savedTheme()) setTheme(e.matches ? "light" : "dark", false); });
$("#theme").onclick = () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
