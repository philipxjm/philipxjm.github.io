/* Local PDF editor front-end (no build step). */
"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};

const S = {
  doc: null, zoom: 1, tool: "select", objs: {}, sel: null, observer: null, current: 0,
  search: { q: "", hits: [], idx: -1 }, editor: null, busy: 0,
};
const DRAW_TOOLS = ["highlight", "underline", "strikeout", "rect", "ellipse", "arrow", "ink", "whiteout", "redact"];
const FAMILY_CSS = {
  helvetica: "Helvetica, Arial, 'Liberation Sans', sans-serif", times: "'Times New Roman', Times, 'Liberation Serif', serif",
  courier: "'Courier New', Courier, monospace", "noto-sans": "'Noto Sans', sans-serif", "fira-sans": "'Fira Sans', sans-serif",
  ubuntu: "Ubuntu, sans-serif", "cascadia-mono": "'Cascadia Mono', monospace",
};

/* ------------------------------------------------------------------ utilities */
async function api(path, opts = {}) {
  const init = { method: opts.method || (opts.body || opts.form ? "POST" : "GET"), headers: {} };
  if (opts.form) init.body = opts.form;
  else if (opts.body) { init.body = JSON.stringify(opts.body); init.headers["Content-Type"] = "application/json"; }
  const res = await (window.PDFBackend ? PDFBackend.fetch(path, init) : fetch(path, init));
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && (data.detail || data.error)) || `${res.status} ${res.statusText}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}
function toast(msg, type = "") {
  const t = h("div", { class: "toast " + type }, msg);
  $("#toasts").append(t);
  while ($("#toasts").children.length > 4) $("#toasts").firstChild.remove();
  setTimeout(() => t.remove(), type === "error" ? 7000 : 4500);
}
function busy(on) {
  S.busy += on ? 1 : -1;
  $("#busy").classList.toggle("hidden", S.busy <= 0);
}
const pt = (px) => px / S.zoom;
const px = (p) => p * S.zoom;
const r2 = (v) => Math.round(v * 100) / 100;
function relPoint(e, el) {
  const b = el.getBoundingClientRect();
  return [pt(e.clientX - b.left), pt(e.clientY - b.top)];
}
function renderScale() {
  return Math.min(5, Math.max(0.5, Math.round(S.zoom * (window.devicePixelRatio || 1) * 4) / 4));
}
function pageURL(i, scale) { return `/api/docs/${S.doc.id}/v/${S.doc.version}/page/${i}.png?scale=${scale}`; }
// In the browser-only build (window.PDFBackend) page images come back as blob URLs from the worker.
function setImg(img, url, low = false) {
  if (!window.PDFBackend) { img.src = url; return; }
  img.dataset.want = url;
  PDFBackend.imageURL(url, low).then((u) => { if (img.dataset.want === url) img.src = u; }).catch(() => {});
}
const thumbObserver = window.PDFBackend && new IntersectionObserver((entries) => {
  for (const en of entries) if (en.isIntersecting) { thumbObserver.unobserve(en.target); setImg(en.target, en.target.dataset.src, true); }
}, { root: document.querySelector("#thumbs"), rootMargin: "400px 0px" });
function thumbImg(url) {
  if (!thumbObserver) return h("img", { src: url, loading: "lazy", alt: "" });
  const img = h("img", { alt: "", "data-src": url });
  thumbObserver.observe(img);
  return img;
}
function placeBox(el, rect) {
  Object.assign(el.style, { left: px(rect[0]) + "px", top: px(rect[1]) + "px", width: Math.max(2, px(rect[2] - rect[0])) + "px", height: Math.max(2, px(rect[3] - rect[1])) + "px" });
}
function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
}
function pickFile(input) {
  return new Promise((resolve) => {
    input.value = "";
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}
async function uploadAsset(file) {
  const fd = new FormData();
  fd.append("file", file);
  return api("/api/uploads", { form: fd });
}

/* ------------------------------------------------------------------ modal */
function modal(title, body, buttons) {
  return new Promise((resolve) => {
    const box = $("#modal-box");
    box.innerHTML = "";
    const close = (v) => { $("#modal").classList.add("hidden"); document.removeEventListener("keydown", onKey); resolve(v); };
    const onKey = (e) => { if (e.key === "Escape") close(null); };
    document.addEventListener("keydown", onKey);
    box.append(h("h3", {}, title), body, h("div", { class: "actions" },
      buttons.map((b) => h("button", { class: b.primary ? "btn primary" : "", onclick: () => close(b.value ? b.value() : b.label) }, b.label))));
    $("#modal").classList.remove("hidden");
    const first = $("input, textarea", box);
    if (first) first.focus();
  });
}
async function promptText(title, label, value = "", multiline = false) {
  const inp = multiline ? h("textarea", {}, value) : h("input", { type: "text", value });
  const res = await modal(title, h("div", {}, h("label", {}, label), inp),
    [{ label: "Cancel" }, { label: "OK", primary: true, value: () => ({ v: inp.value }) }]);
  return res && typeof res === "object" ? res.v : null;
}

/* ------------------------------------------------------------------ home / documents */
async function showHome() {
  closeEditor();
  S.doc = null;
  location.hash = "";
  $("#workspace").classList.add("hidden");
  $("#home").classList.remove("hidden");
  $("#doc-name").textContent = "";
  setDocButtons();
  const list = await api("/api/docs").catch(() => []);
  const rec = $("#recent");
  rec.innerHTML = "";
  if (list.length) rec.append(h("h3", {}, "Recent documents"));
  for (const d of list) {
    rec.append(h("div", { class: "item" },
      h("span", { class: "name", onclick: () => openDoc(d.id) }, d.name),
      h("span", { class: "when" }, d.updated ? new Date(d.updated * 1000).toLocaleString() : ""),
      h("button", { class: "danger", title: "Delete this document and its history", onclick: async () => {
        if (!confirm(`Delete "${d.name}" and its edit history?`)) return;
        await api(`/api/docs/${d.id}`, { method: "DELETE" });
        showHome();
      } }, "Delete")));
  }
}

async function uploadDoc(file, password = "") {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("password", password);
  busy(true);
  try {
    const doc = await api("/api/docs", { form: fd });
    await openDoc(doc.id, doc);
  } catch (e) {
    if (e.status === 401 && e.data && e.data.needs_password) {
      const pw = await promptText("Password required", password ? "Wrong password, try again:" : "This PDF is encrypted. Password:");
      if (pw !== null) return uploadDoc(file, pw);
    } else toast(e.message, "error");
  } finally { busy(false); }
}

async function openDoc(id, preloaded = null) {
  busy(true);
  try {
    S.doc = preloaded || await api(`/api/docs/${id}`);
  } catch (e) { toast(e.message, "error"); busy(false); return showHome(); }
  busy(false);
  location.hash = "doc=" + S.doc.id;
  $("#home").classList.add("hidden");
  $("#workspace").classList.remove("hidden");
  S.objs = {}; S.sel = null; S.search = { q: "", hits: [], idx: -1 };
  requestAnimationFrame(() => { fitWidth(false); buildAll(); });
}

function setDocButtons() {
  const d = S.doc;
  $("#btn-undo").disabled = !d || !d.can_undo;
  $("#btn-redo").disabled = !d || !d.can_redo;
  $("#btn-download").href = d ? `/api/docs/${d.id}/download` : "#";
  if (d) $("#doc-name").textContent = d.name;
}

/* ------------------------------------------------------------------ pages */
function buildAll() {
  setDocButtons();
  buildPages();
  buildThumbs();
  renderPanel();
}

function buildPages() {
  const wrap = $("#pages");
  const keepScroll = $("#viewer").scrollTop / Math.max(1, $("#viewer").scrollHeight);
  wrap.innerHTML = "";
  if (S.observer) S.observer.disconnect();
  S.observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) ensurePage(+en.target.dataset.p);
  }, { root: $("#viewer"), rootMargin: "600px 0px" });
  S.doc.pages.forEach((pg, i) => {
    const el = h("div", { class: "page", "data-p": i, style: { width: px(pg.w) + "px", height: px(pg.h) + "px" } },
      h("img", { alt: "" }), h("div", { class: "overlay", "data-p": i, onpointerdown: onOverlayDown, ondblclick: onOverlayDblClick }),
      h("div", { class: "pno" }, String(i + 1)));
    wrap.append(el);
    S.observer.observe(el);
  });
  $("#viewer").scrollTop = keepScroll * $("#viewer").scrollHeight;
  $("#zoom-label").textContent = Math.round(S.zoom * 100) + "%";
}

function pageEl(i) { return $(`.page[data-p="${i}"]`); }
function overlayEl(i) { return $(`.overlay[data-p="${i}"]`); }

async function ensurePage(i, force = false) {
  const el = pageEl(i);
  if (!el || !S.doc) return;
  const ver = String(S.doc.version), scale = renderScale();
  const img = $("img", el);
  if (force || el.dataset.ver !== ver || el.dataset.scale !== String(scale)) {
    el.dataset.ver = ver; el.dataset.scale = String(scale);
    setImg(img, pageURL(i, scale));
  }
  if (force || !S.objs[i] || S.objs[i].ver !== ver) {
    try {
      const o = await api(`/api/docs/${S.doc.id}/v/${ver}/page/${i}/objects`);
      if (String(S.doc.version) !== ver) return;
      S.objs[i] = { ...o, ver };
    } catch (e) { return; }
  }
  drawOverlay(i);
}

function visiblePages() {
  const v = $("#viewer").getBoundingClientRect();
  return $$(".page").filter((el) => { const b = el.getBoundingClientRect(); return b.bottom > v.top - 400 && b.top < v.bottom + 400; })
    .map((el) => +el.dataset.p);
}

function drawOverlay(i) {
  const ov = overlayEl(i), o = S.objs[i];
  if (!ov || !o) return;
  [...ov.children].forEach((c) => { if (!c.classList.contains("editor-wrap")) c.remove(); });
  const add = (cls, kind, obj, title) => {
    const el = h("div", { class: `obj ${cls}`, "data-kind": kind, "data-id": obj.id, title });
    placeBox(el, obj.rect);
    if (S.sel && S.sel.page === i && S.sel.kind === kind && S.sel.id === obj.id) el.classList.add("selected");
    ov.append(el);
    return el;
  };
  for (const im of o.images) add("image", "image", im, `Image ${im.width}×${im.height}px${im.uses > 1 ? ` (used ${im.uses}×)` : ""}`);
  for (const r of o.runs) add("text", "text", r, `${r.font} · ${r.size}pt`);
  for (const a of o.annots) add("annot", "annot", a, `${a.type} annotation`);
  for (const w of o.widgets) add("widget", "widget", w, `${w.type} field "${w.name}"`);
  S.search.hits.forEach((hit, k) => {
    if (hit.page !== i) return;
    const el = h("div", { class: "search-hit" + (k === S.search.idx ? " current" : "") });
    placeBox(el, hit.rect);
    ov.append(el);
  });
  if (S.sel && S.sel.page === i) addHandles();
}

function refreshAfterChange(prevPages, keep = null) {
  const sizesChanged = !prevPages || prevPages.length !== S.doc.pages.length ||
    prevPages.some((p, k) => p.w !== S.doc.pages[k].w || p.h !== S.doc.pages[k].h || p.rotation !== S.doc.pages[k].rotation);
  S.objs = {};
  S.sel = null;
  document.body.classList.remove("has-sel");
  if (!keep) setLock(false);
  setDocButtons();
  if (sizesChanged) buildPages();
  else visiblePages().forEach((i) => ensurePage(i));
  buildThumbs();
  renderPanel();
  if (keep) reselect(keep);
}
// keep = {page, kind: "image"|"annot", rect, xref?}: select the object now at that spot (image ids are positional)
async function reselect(keep) {
  await ensurePage(keep.page);
  const o = S.objs[keep.page];
  const list = (o && (keep.kind === "image" ? o.images : o.annots)) || [];
  const r = keep.rect;
  const overlap = (q) => Math.max(0, Math.min(q[2], r[2]) - Math.max(q[0], r[0])) * Math.max(0, Math.min(q[3], r[3]) - Math.max(q[1], r[1]));
  let best = keep.kind === "annot" && keep.xref ? list.find((x) => x.xref === keep.xref) : null;
  if (!best) best = list.reduce((b, x) => (overlap(x.rect) > (b ? overlap(b.rect) : 0) ? x : b), null);
  if (best && !S.sel) select(keep.page, keep.kind, best.id);
  else if (!S.sel) setLock(false);
}

/* ------------------------------------------------------------------ thumbnails */
function buildThumbs() {
  const t = $("#thumbs");
  t.innerHTML = "";
  if (thumbObserver) thumbObserver.disconnect();
  const n = S.doc.pages.length;
  S.doc.pages.forEach((pg, i) => {
    const act = (label, title, fn, dis) => h("button", { title, disabled: dis, onclick: (e) => { e.stopPropagation(); fn(); } }, label);
    t.append(h("div", { class: "thumb" + (i === S.current ? " current" : ""), "data-p": i, onclick: () => scrollToPage(i) },
      thumbImg(pageURL(i, 0.22)),
      h("div", { class: "num" }, String(i + 1)),
      h("div", { class: "tactions" },
        act("↺", "Rotate left", () => pageOp({ action: "rotate", page: i, degrees: -90 })),
        act("↻", "Rotate right", () => pageOp({ action: "rotate", page: i, degrees: 90 })),
        act("▲", "Move up", () => pageOp({ action: "move", page: i, to: i - 1 }), i === 0),
        act("▼", "Move down", () => pageOp({ action: "move", page: i, to: i + 1 }), i === n - 1),
        act("⧉", "Duplicate page", () => pageOp({ action: "duplicate", page: i })),
        act("＋", "Insert blank page after", () => pageOp({ action: "insert_blank", page: i })),
        act("⇣", "Insert pages from a PDF after this page", () => insertPdfAfter(i)),
        act("✕", "Delete page", () => { if (confirm(`Delete page ${i + 1}?`)) pageOp({ action: "delete", page: i }); }, n === 1))));
  });
}
function scrollToPage(i) {
  const el = pageEl(i);
  if (el) $("#viewer").scrollTo({ top: el.offsetTop - 16, behavior: "smooth" });
}
function trackCurrent() {
  const v = $("#viewer").getBoundingClientRect();
  let best = 0, bestVis = -1;
  for (const el of $$(".page")) {
    const b = el.getBoundingClientRect();
    const vis = Math.min(b.bottom, v.bottom) - Math.max(b.top, v.top);
    if (vis > bestVis) { bestVis = vis; best = +el.dataset.p; }
  }
  if (best !== S.current) {
    S.current = best;
    $$(".thumb").forEach((t) => t.classList.toggle("current", +t.dataset.p === best));
  }
}
async function pageOp(op) { await runOps([{ type: "page", ...op }]); }
async function insertPdfAfter(i) {
  const f = await pickFile($("#file-insert"));
  if (!f) return;
  busy(true);
  try {
    const up = await uploadAsset(f);
    await runOps([{ type: "page", action: "insert_pdf", page: i, upload: up.id }]);
  } catch (e) { toast(e.message, "error"); } finally { busy(false); }
}

/* ------------------------------------------------------------------ operations */
async function runOps(ops, keep = null) {
  if (!S.doc) return;
  const prev = S.doc.pages;
  busy(true);
  try {
    const res = await api(`/api/docs/${S.doc.id}/ops`, { body: { version: S.doc.version, ops } });
    S.doc = res;
    (res.notes || []).forEach((n) => toast(n));
    refreshAfterChange(prev, keep);
    return true;
  } catch (e) {
    toast(e.message, "error");
    if (e.status === 409) openDoc(S.doc.id);
    return false;
  } finally { busy(false); }
}
async function undoRedo(which) {
  if (!S.doc) return;
  closeEditor();
  const prev = S.doc.pages;
  busy(true);
  try { S.doc = await api(`/api/docs/${S.doc.id}/${which}`, { method: "POST" }); refreshAfterChange(prev); }
  catch (e) { toast(e.message, "error"); } finally { busy(false); }
}

/* ------------------------------------------------------------------ selection & panel */
function findObj(page, kind, id) {
  const o = S.objs[page];
  if (!o) return null;
  const list = { text: o.runs, image: o.images, widget: o.widgets, annot: o.annots }[kind];
  return list ? list.find((x) => x.id === id) : null;
}
// While an image or annotation is selected the viewer ignores touch panning and swipes (see style.css),
// so on a touch screen a finger only moves or resizes the selection until it is deselected.
function deleteSelection() {
  const o = S.sel && findObj(S.sel.page, S.sel.kind, S.sel.id);
  if (!o) return;
  const page = S.sel.page;
  if (S.sel.kind === "text") runOps([{ type: "delete_text", page, id: o.id }]);
  else if (S.sel.kind === "image") runOps([{ type: "delete_image", page, id: o.id, xref: o.xref }]);
  else if (S.sel.kind === "annot") runOps([{ type: "delete_annot", page, xref: o.xref }]);
  else if (S.sel.kind === "widget") runOps([{ type: "delete_widget", page, xref: o.xref }]);
}
const SEL_HINT = { image: "Drag to move · drag a corner to resize", annot: "Drag to move · drag a corner to resize",
  text: "Double-tap to edit", widget: "Set its value below" };
function setLock(on) {
  document.body.classList.toggle("obj-lock", !!on);
}
const COARSE = matchMedia("(pointer: coarse)");
function select(page, kind, id) {
  $$(".obj.selected").forEach((e) => e.classList.remove("selected"));
  $$(".handle").forEach((e) => e.remove());
  S.sel = kind ? { page, kind, id } : null;
  setLock(S.sel && (kind === "image" || kind === "annot"));
  document.body.classList.toggle("has-sel", !!S.sel);
  if (S.sel) $("#lock-bar span").textContent = SEL_HINT[kind] || "";
  if (S.sel) {
    const el = $(`.overlay[data-p="${page}"] .obj[data-kind="${kind}"][data-id="${id}"]`);
    if (el) el.classList.add("selected");
    addHandles();
  }
  renderPanel();
}
// Handles are moved in place, never recreated, while dragging: removing the element under a finger ends the touch.
function addHandles() {
  const obj = S.sel && ["image", "annot"].includes(S.sel.kind) && findObj(S.sel.page, S.sel.kind, S.sel.id);
  const ov = obj && overlayEl(S.sel.page);
  $$(".handle").forEach((e) => { if (!ov || e.parentNode !== ov) e.remove(); });
  if (!ov) return;
  const [x0, y0, x1, y1] = obj.rect.map(px);
  const pos = { nw: [x0, y0], n: [(x0 + x1) / 2, y0], ne: [x1, y0], e: [x1, (y0 + y1) / 2], se: [x1, y1], s: [(x0 + x1) / 2, y1], sw: [x0, y1], w: [x0, (y0 + y1) / 2] };
  let keys = $$(".handle", ov).map((e) => e.dataset.h);
  if (!keys.length) {
    // big touch targets on small boxes: corners only, so the middle stays free for moving
    const small = COARSE.matches && (x1 - x0 < 110 || y1 - y0 < 110);
    keys = small ? ["nw", "ne", "se", "sw"] : Object.keys(pos);
    for (const k of keys) ov.append(h("div", { class: "handle", "data-h": k }));
  }
  for (const k of keys) {
    const el = $(`.handle[data-h="${k}"]`, ov);
    el.style.left = pos[k][0] + "px"; el.style.top = pos[k][1] + "px";
  }
}

function renderPanel() {
  const body = $("#panel-body");
  if (!S.doc) return;
  const sel = S.sel && findObj(S.sel.page, S.sel.kind, S.sel.id);
  if (!sel) {
    body.innerHTML = `<p class="hint">Click any text, image, form field or annotation to select it.<br><br>
      <b>Double-click</b> text to edit it in place (Enter applies, Shift+Enter adds a line). Drag images and annotations to move them; drag the handles to resize.<br><br>
      Tools in the top bar add text, images, highlights, shapes, drawings, notes, white-out and redaction.<br><br>
      Shortcuts: <kbd>Del</kbd> delete selection · <kbd>Ctrl+Z</kbd>/<kbd>Ctrl+Shift+Z</kbd> undo/redo · <kbd>Ctrl+F</kbd> find · <kbd>V</kbd>/<kbd>T</kbd> tools · <kbd>I</kbd> add image · <kbd>Esc</kbd> deselect.</p>
      <p class="kv">${S.doc.page_count} page(s) · version ${S.doc.version}</p>`;
    return;
  }
  const page = S.sel.page;
  body.innerHTML = "";
  const kv = (k, v) => h("div", { class: "kv" }, `${k}: ${v}`);
  const put = (...kids) => body.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false)); // append() would print "null"
  if (S.sel.kind === "text") {
    put(h("h3", {}, "Text"),
      h("div", { class: "row" }, h("label", { class: "f" }, "Content"), h("div", { style: { whiteSpace: "pre-wrap", wordBreak: "break-word" } }, sel.text)),
      kv("Font", sel.font), kv("Size", sel.size + " pt"), kv("Colour", sel.color),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", onclick: () => openEditor({ mode: "edit", page, run: sel }) }, "Edit text"),
        h("button", { onclick: () => openEditor({ mode: "edit", page, run: sel, line: true }) }, "Edit whole line"),
        h("button", { class: "danger", onclick: () => runOps([{ type: "delete_text", page, id: sel.id }]) }, "Delete")));
  } else if (S.sel.kind === "image") {
    const [x0, y0, x1, y1] = sel.rect;
    const inputs = ["X", "Y", "W", "H"].map((l, k) => h("input", { type: "text", value: r2([x0, y0, x1 - x0, y1 - y0][k]), style: { width: "60px" }, title: l }));
    const fit = h("select", {}, h("option", { value: "stretch" }, "Stretch to box"), h("option", { value: "fit" }, "Fit inside box"));
    put(h("h3", {}, "Image"),
      kv("Pixels", `${sel.width} × ${sel.height}`), sel.inline ? kv("Type", "inline image") : kv("Object", `#${sel.xref}`),
      sel.uses > 1 ? h("div", { class: "warn" }, `This image is used ${sel.uses} times in the document. Replacing changes every copy; moving or deleting this copy keeps the others where possible.`) : null,
      h("div", { class: "row" }, h("label", { class: "f" }, "Position & size (pt): X Y W H"), h("div", { style: { display: "flex", gap: "4px" } }, ...inputs)),
      h("div", { class: "actions" },
        h("button", { onclick: () => {
          const [x, y, w, hh] = inputs.map((i) => parseFloat(i.value));
          if ([x, y, w, hh].some(isNaN) || w <= 0 || hh <= 0) return toast("Invalid geometry", "error");
          runOps([{ type: "move_image", page, id: sel.id, xref: sel.xref, rect: [x, y, x + w, y + hh] }], { page, kind: "image", rect: [x, y, x + w, y + hh] });
        } }, "Apply size")),
      h("div", { class: "row" }, h("label", { class: "f" }, "Replace with a new picture"), fit),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", onclick: async () => {
          const f = await pickFile($("#file-replace"));
          if (!f) return;
          busy(true);
          try { const up = await uploadAsset(f); await runOps([{ type: "replace_image", page, id: sel.id, xref: sel.xref, upload: up.id, fit: fit.value }]); }
          catch (e) { toast(e.message, "error"); } finally { busy(false); }
        } }, "Replace…"),
        h("button", { class: "danger", onclick: () => runOps([{ type: "delete_image", page, id: sel.id, xref: sel.xref }]) }, "Delete")));
  } else if (S.sel.kind === "widget") {
    let input;
    const t = sel.type;
    if (t === "CheckBox" || t === "RadioButton") input = h("input", { type: "checkbox", checked: sel.value && sel.value !== "Off" });
    else if ((t === "ComboBox" || t === "ListBox") && sel.choices.length) {
      input = h("select", {}, sel.choices.map((c) => { const v = Array.isArray(c) ? c[0] : c; return h("option", { value: v, selected: v === sel.value }, Array.isArray(c) ? c[1] : c); }));
    } else input = h(t === "Text" ? "textarea" : "input", { type: "text" }, t === "Text" ? String(sel.value || "") : null);
    if (input.tagName === "INPUT" && input.type === "text") input.value = sel.value || "";
    put(h("h3", {}, `Form field: ${sel.name}`), kv("Type", t), sel.readonly ? h("div", { class: "warn" }, "Marked read-only in the PDF.") : null,
      h("div", { class: "row" }, h("label", { class: "f" }, "Value"), input),
      h("div", { class: "actions" }, h("button", { class: "btn primary", onclick: () => {
        const value = input.type === "checkbox" ? input.checked : input.value;
        runOps([{ type: "set_field", page, xref: sel.xref, value }]);
      } }, "Save value"),
      h("button", { class: "danger", onclick: () => { if (confirm(`Delete the form field "${sel.name}"?`)) deleteSelection(); } }, "Delete field")));
    if (!COARSE.matches) input.focus();
  } else if (S.sel.kind === "annot") {
    const ta = sel.editable_content ? h("textarea", {}, sel.content || "") : null;
    put(h("h3", {}, `${sel.type} annotation`),
      ta ? h("div", { class: "row" }, h("label", { class: "f" }, "Text"), ta) : (sel.content ? kv("Content", sel.content) : null),
      h("div", { class: "actions" },
        ta ? h("button", { class: "btn primary", onclick: () => runOps([{ type: "edit_annot", page, xref: sel.xref, content: ta.value }]) }, "Save text") : null,
        h("button", { class: "danger", onclick: () => runOps([{ type: "delete_annot", page, xref: sel.xref }]) }, "Delete")));
  }
}

/* ------------------------------------------------------------------ inline text editor */
function closeEditor() {
  if (S.editor) { S.editor.wrap.remove(); S.editor = null; }
}
function openEditor({ mode, page, run = null, x = 0, y = 0, line = false }) {
  closeEditor();
  const ov = overlayEl(page);
  if (!ov) return;
  let text = run ? run.text : "", rect = run ? run.rect : [x, y, x + 120, y + 16];
  let lineRuns = null;
  if (run && line) {
    lineRuns = S.objs[page].runs.filter((r) => r.line === run.line);
    text = lineRuns.map((r) => r.text).join(" ");
    rect = [Math.min(...lineRuns.map((r) => r.rect[0])), Math.min(...lineRuns.map((r) => r.rect[1])),
      Math.max(...lineRuns.map((r) => r.rect[2])), Math.max(...lineRuns.map((r) => r.rect[3]))];
  }
  const base = run ? { family: "original", size: run.size, color: run.color, bold: run.bold, italic: run.italic }
    : { family: "helvetica", size: 12, color: "#000000", bold: false, italic: false };
  const st = { ...base };
  const famSel = h("select", { title: "Font" }, S.doc.fonts.filter((f) => run || f.id !== "original").map((f) => h("option", { value: f.id, selected: f.id === st.family }, f.label)));
  const size = h("input", { type: "number", value: r2(st.size), min: 1, max: 400, step: 0.5, title: "Size (pt)" });
  const color = h("input", { type: "color", value: st.color, title: "Colour" });
  const bBtn = h("button", { class: st.bold ? "on" : "", title: "Bold" }, h("b", {}, "B"));
  const iBtn = h("button", { class: st.italic ? "on" : "", title: "Italic" }, h("i", {}, "I"));
  const ed = h("div", { class: "editor", contenteditable: "plaintext-only", spellcheck: "true", "data-placeholder": "Type…" });
  ed.textContent = text;
  const fam = () => (st.family === "original" ? (run ? run.family : "helvetica") : st.family);
  const restyle = () => {
    Object.assign(ed.style, { fontSize: px(st.size) + "px", fontFamily: FAMILY_CSS[fam()] || FAMILY_CSS.helvetica, color: st.color,
      fontWeight: st.bold ? "700" : "400", fontStyle: st.italic ? "italic" : "normal", minWidth: px(rect[2] - rect[0]) + 4 + "px" });
  };
  famSel.onchange = () => { st.family = famSel.value; restyle(); };
  size.oninput = () => { st.size = parseFloat(size.value) || st.size; restyle(); };
  color.oninput = () => { st.color = color.value; restyle(); };
  bBtn.onclick = () => { st.bold = !st.bold; bBtn.classList.toggle("on", st.bold); restyle(); ed.focus(); };
  iBtn.onclick = () => { st.italic = !st.italic; iBtn.classList.toggle("on", st.italic); restyle(); ed.focus(); };
  const apply = async () => {
    const newText = ed.innerText.replace(/\n+$/, "");
    const style = {};
    if (st.family !== base.family) style.family = st.family;
    if (Math.abs(st.size - base.size) > 0.01) style.size = st.size;
    if (st.color.toLowerCase() !== String(base.color).toLowerCase()) style.color = st.color;
    if (st.bold !== base.bold) style.bold = st.bold;
    if (st.italic !== base.italic) style.italic = st.italic;
    if (mode === "edit") {
      if (newText === text && !Object.keys(style).length) return closeEditor();
      const op = { type: "edit_text", page, text: newText, style };
      if (lineRuns) op.line = run.line; else op.id = run.id;
      closeEditor();
      await runOps([op]);
    } else {
      closeEditor();
      if (!newText.trim()) return;
      if (style.family === undefined) style.family = st.family;
      style.size = st.size; style.color = st.color; style.bold = st.bold; style.italic = st.italic;
      await runOps([{ type: "add_text", page, x: rect[0], y: rect[1], text: newText, style }]);
    }
  };
  const bar = h("div", { class: "ed-bar", onpointerdown: (e) => e.stopPropagation() }, famSel, size, color, bBtn, iBtn,
    h("button", { class: "btn primary", title: "Apply (Enter)", onclick: apply }, "✓"),
    h("button", { title: "Cancel (Esc)", onclick: closeEditor }, "✕"),
    mode === "edit" ? h("button", { class: "danger", title: "Delete this text", onclick: () => { closeEditor(); runOps([{ type: "delete_text", page, id: run.id }]); } }, "🗑") : null);
  const wrap = h("div", { class: "editor-wrap", style: { left: px(rect[0]) - 3 + "px", top: px(rect[1]) - 2 + "px" }, onpointerdown: (e) => e.stopPropagation() }, bar, ed);
  ov.append(wrap);
  restyle();
  ed.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); apply(); }
    else if (e.key === "Escape") { e.preventDefault(); closeEditor(); }
    e.stopPropagation();
  });
  S.editor = { wrap, apply };
  ed.focus();
  const sel = window.getSelection(), range = document.createRange();
  range.selectNodeContents(ed);
  sel.removeAllRanges(); sel.addRange(range);
}

/* ------------------------------------------------------------------ pointer interaction */
function onOverlayDown(e) {
  if (e.button !== 0) return;
  const ov = e.currentTarget, page = +ov.dataset.p;
  if (S.editor) { S.editor.apply(); return; }
  const [x, y] = relPoint(e, ov);
  if (S.tool === "select") return selectDown(e, ov, page, x, y);
  if (S.tool === "text") { e.preventDefault(); openEditor({ mode: "add", page, x, y }); return; }
  if (S.tool === "note") { e.preventDefault(); addNote(page, x, y); return; }
  if (S.tool === "ink") return inkDown(e, ov, page);
  if (S.tool === "arrow") return lineDown(e, ov, page, x, y);
  return rectDown(e, ov, page, x, y);
}

function selectDown(e, ov, page, x, y) {
  const handle = e.target.closest(".handle");
  const objEl = e.target.closest(".obj");
  const onSelected = objEl && S.sel && S.sel.page === page && objEl.dataset.kind === S.sel.kind && objEl.dataset.id === S.sel.id;
  const touch = e.pointerType !== "mouse";
  if (touch && document.body.classList.contains("obj-lock") && !handle && !onSelected) {
    e.preventDefault();
    return onTap(e, () => select(null, null, null));  // locked: a tap anywhere else deselects, a swipe does nothing
  }
  // touch: select on a clean tap, so a swipe that starts on an object still scrolls the page
  if (touch && !handle && !onSelected) return onTap(e, () => (objEl ? select(page, objEl.dataset.kind, objEl.dataset.id) : select(null, null, null)));
  if (!handle && !objEl) { select(null, null, null); return; }
  if (handle && S.sel) return dragObject(e, ov, S.sel.page, S.sel.kind, S.sel.id, handle.dataset.h);
  const kind = objEl.dataset.kind, id = objEl.dataset.id;
  if (!onSelected) select(page, kind, id);
  if (kind === "image" || kind === "annot") dragObject(e, ov, page, kind, id, null);
}

// Runs fn if this pointer is released close to where it went down, quickly (a tap rather than a swipe).
function onTap(e, fn) {
  const x0 = e.clientX, y0 = e.clientY, t0 = performance.now();
  const done = (ev) => {
    window.removeEventListener("pointerup", done);
    window.removeEventListener("pointercancel", done);
    if (ev.type === "pointerup" && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 12 && performance.now() - t0 < 600) fn();
  };
  window.addEventListener("pointerup", done);
  window.addEventListener("pointercancel", done);
}

function dragObject(e, ov, page, kind, id, handleDir) {
  const obj = findObj(page, kind, id);
  if (!obj) return;
  e.preventDefault();
  const start = relPoint(e, ov), r0 = [...obj.rect];
  const el = $(`.obj[data-kind="${kind}"][data-id="${id}"]`, ov);
  let r = r0, moved = false;
  const aspect = (r0[2] - r0[0]) / Math.max(0.01, r0[3] - r0[1]);
  const onMove = (ev) => {
    const [cx, cy] = relPoint(ev, ov);
    const dx = cx - start[0], dy = cy - start[1];
    if (Math.abs(px(dx)) + Math.abs(px(dy)) > 2) moved = true;
    if (!handleDir) r = [r0[0] + dx, r0[1] + dy, r0[2] + dx, r0[3] + dy];
    else {
      let [a, b, c, d] = r0;
      if (handleDir.includes("w")) a += dx;
      if (handleDir.includes("e")) c += dx;
      if (handleDir.includes("n")) b += dy;
      if (handleDir.includes("s")) d += dy;
      if (ev.shiftKey && handleDir.length === 2) { const w = c - a; const hh = w / aspect; if (handleDir.includes("n")) b = d - hh; else d = b + hh; }
      r = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    }
    placeBox(el, r);
    obj.rect = r; addHandles(); obj.rect = r0;
  };
  const stop = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  };
  const onCancel = () => { stop(); placeBox(el, r0); addHandles(); };  // the browser took the touch (scroll, gesture)
  const onUp = async () => {
    stop();
    if (!moved || r[2] - r[0] < 1 || r[3] - r[1] < 1) { placeBox(el, r0); addHandles(); return; }
    const rect = r.map(r2), keep = { page, kind, rect, xref: obj.xref };
    if (kind === "image") await runOps([{ type: "move_image", page, id, xref: obj.xref, rect }], keep);
    else await runOps([{ type: "move_annot", page, xref: obj.xref, rect }], keep);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onCancel);
}

function rectDown(e, ov, page, x0, y0) {
  e.preventDefault();
  const draft = h("div", { class: "draft" });
  ov.append(draft);
  let r = [x0, y0, x0, y0];
  const onMove = (ev) => {
    const [x, y] = relPoint(ev, ov);
    r = [Math.min(x0, x), Math.min(y0, y), Math.max(x0, x), Math.max(y0, y)];
    placeBox(draft, r);
  };
  const onUp = async () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    draft.remove();
    const small = r[2] - r[0] < 3 || r[3] - r[1] < 3;
    const rect = r.map(r2);
    const color = $("#opt-color").value, width = parseFloat($("#opt-width").value) || 1.5;
    const fill = $("#opt-fill-on").checked ? $("#opt-fill").value : null;
    if (small) return;
    if (["highlight", "underline", "strikeout"].includes(S.tool))
      return runOps([{ type: "annotate", page, kind: S.tool, rect, color: S.tool === "highlight" && color === "#e11d48" ? "#facc15" : color }]);
    if (S.tool === "rect" || S.tool === "ellipse") return runOps([{ type: "annotate", page, kind: S.tool, rect, color, fill, width }]);
    if (S.tool === "whiteout") return runOps([{ type: "whiteout", page, rect, fill: "#ffffff" }]);
    if (S.tool === "redact") {
      if (!confirm("Redaction permanently removes text, images and drawings in this area. Continue?")) return;
      return runOps([{ type: "redact", page, rect, fill: "#000000" }]);
    }
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function svgLayer(ov) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "draft-svg");
  ov.append(svg);
  return svg;
}
function lineDown(e, ov, page, x0, y0) {
  e.preventDefault();
  const svg = svgLayer(ov);
  const ln = document.createElementNS(svg.namespaceURI, "line");
  Object.entries({ x1: px(x0), y1: px(y0), x2: px(x0), y2: px(y0), stroke: $("#opt-color").value, "stroke-width": 2 }).forEach(([k, v]) => ln.setAttribute(k, v));
  svg.append(ln);
  let p2 = [x0, y0];
  const onMove = (ev) => { p2 = relPoint(ev, ov); ln.setAttribute("x2", px(p2[0])); ln.setAttribute("y2", px(p2[1])); };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    svg.remove();
    if (Math.hypot(p2[0] - x0, p2[1] - y0) < 3) return;
    runOps([{ type: "annotate", page, kind: "arrow", p1: [r2(x0), r2(y0)], p2: p2.map(r2), color: $("#opt-color").value, width: parseFloat($("#opt-width").value) || 1.5 }]);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
function inkDown(e, ov, page) {
  e.preventDefault();
  const svg = svgLayer(ov);
  const path = document.createElementNS(svg.namespaceURI, "polyline");
  Object.entries({ fill: "none", stroke: $("#opt-color").value, "stroke-width": Math.max(1, px(parseFloat($("#opt-width").value) || 1.5)), "stroke-linecap": "round", "stroke-linejoin": "round" }).forEach(([k, v]) => path.setAttribute(k, v));
  svg.append(path);
  const pts = [relPoint(e, ov)];
  const draw = () => path.setAttribute("points", pts.map(([x, y]) => `${px(x)},${px(y)}`).join(" "));
  const onMove = (ev) => { pts.push(relPoint(ev, ov)); draw(); };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    svg.remove();
    if (pts.length < 2) return;
    runOps([{ type: "annotate", page, kind: "ink", points: [pts.map((p) => p.map(r2))], color: $("#opt-color").value, width: parseFloat($("#opt-width").value) || 1.5 }]);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}
async function addNote(page, x, y) {
  const text = await promptText("Sticky note", "Note text", "", true);
  if (text === null) return;
  runOps([{ type: "annotate", page, kind: "note", point: [r2(x), r2(y)], content: text, color: "#facc15" }]);
}
// Adds a picture to a page and selects it. Without a point it goes in the middle of the page's visible part.
async function addImageAt(page, point = null, file = null) {
  file = file || await pickFile($("#file-image"));
  if (!file) return;
  busy(true);
  try {
    const up = await uploadAsset(file);
    const pg = S.doc.pages[page];
    const w = Math.min(200, pg.w * 0.4);
    const hh = up.width && up.height ? w * up.height / up.width : w * 0.75;
    if (!point) {
      const b = pageEl(page).getBoundingClientRect(), v = $("#viewer").getBoundingClientRect();
      const cy = pt((Math.max(b.top, v.top) + Math.min(b.bottom, v.bottom)) / 2 - b.top);
      point = [pg.w / 2 - w / 2, Math.min(Math.max(0, cy - hh / 2), Math.max(0, pg.h - hh))];
    }
    const rect = [point[0], point[1], point[0] + w, point[1] + hh].map(r2);
    if (S.tool !== "select") setTool("select");
    await runOps([{ type: "add_image", page, rect, upload: up.id, keep_proportion: true }], { page, kind: "image", rect });
  } catch (e) { toast(e.message, "error"); } finally { busy(false); }
}

function onOverlayDblClick(e) {
  if (S.tool !== "select") return;
  const objEl = e.target.closest(".obj");
  if (!objEl) return;
  const page = +e.currentTarget.dataset.p, kind = objEl.dataset.kind;
  const obj = findObj(page, kind, objEl.dataset.id);
  if (!obj) return;
  if (kind === "text") openEditor({ mode: "edit", page, run: obj });
  else if (kind === "annot" && obj.editable_content) promptText("Annotation text", "Text", obj.content || "", true)
    .then((v) => { if (v !== null) runOps([{ type: "edit_annot", page, xref: obj.xref, content: v }]); });
}

/* ------------------------------------------------------------------ tools, zoom, find, misc */
function setTool(t) {
  closeEditor();
  S.tool = t;
  $$("#tools button").forEach((b) => b.classList.toggle("active", b.dataset.tool === t));
  const cls = "tool-" + (t === "select" ? "select" : t === "text" ? "text" : (t === "note" ? "note" : "draw"));
  document.body.classList.remove("tool-select", "tool-text", "tool-note", "tool-draw");
  document.body.classList.add(cls);
  if (t !== "select") select(null, null, null);
}
function setZoom(z) {
  S.zoom = Math.max(0.2, Math.min(5, z));
  closeEditor();
  if (S.doc) buildPages();
}
function fitWidth(rebuild = true) {
  if (!S.doc) return;
  const maxW = Math.max(...S.doc.pages.map((p) => p.w));
  const margin = matchMedia("(max-width: 760px)").matches ? 24 : 90;
  S.zoom = Math.max(0.2, Math.min(3, ($("#viewer").clientWidth - margin) / maxW));
  if (rebuild) buildPages();
}

async function findReplace() {
  if (!S.doc) return;
  const q = h("input", { type: "text", value: S.search.q, placeholder: "Text to find" });
  const rep = h("input", { type: "text", placeholder: "Replacement (leave empty to only find)" });
  const mc = h("input", { type: "checkbox" });
  const info = h("div", { class: "hint", style: { marginTop: "8px" } }, "");
  const body = h("div", {}, h("label", {}, "Find"), q, h("label", {}, "Replace with"), rep,
    h("label", { style: { display: "flex", gap: "6px", alignItems: "center" } }, mc, "Match case"), info,
    h("p", { class: "hint" }, "Replace works on text runs (text in one font/style on a line). Matches split across runs are found but not replaced."));
  const res = await modal("Find & replace", body, [
    { label: "Close" },
    { label: "Find", value: () => ({ act: "find" }) },
    { label: "Replace all", primary: true, value: () => ({ act: "replace" }) },
  ]);
  if (!res || typeof res !== "object") return;
  S.search.q = q.value;
  if (!q.value) return;
  if (res.act === "replace") {
    S.search.hits = [];
    await runOps([{ type: "replace_all", find: q.value, replace: rep.value, match_case: mc.checked }]);
    return;
  }
  const r = await api(`/api/docs/${S.doc.id}/search?q=${encodeURIComponent(q.value)}&match_case=${mc.checked}`);
  S.search.hits = r.hits; S.search.idx = r.hits.length ? 0 : -1;
  toast(r.hits.length ? `${r.hits.length} match(es). Press F3 / Shift+F3 to step through.` : "No matches.");
  visiblePages().forEach(drawOverlay);
  gotoHit(0);
}
function gotoHit(k) {
  const hits = S.search.hits;
  if (!hits.length) return;
  S.search.idx = (k + hits.length) % hits.length;
  const hit = hits[S.search.idx];
  const el = pageEl(hit.page);
  if (el) $("#viewer").scrollTo({ top: el.offsetTop + px(hit.rect[1]) - 120, behavior: "smooth" });
  setTimeout(() => $$(".overlay").forEach((ov) => drawOverlay(+ov.dataset.p)), 50);
}

async function editMetadata() {
  const md = S.doc.metadata || {};
  const fields = ["title", "author", "subject", "keywords"].map((k) => [k, h("input", { type: "text", value: md[k] || "" })]);
  const res = await modal("Document properties", h("div", {}, fields.map(([k, inp]) => [h("label", {}, k[0].toUpperCase() + k.slice(1)), inp])),
    [{ label: "Cancel" }, { label: "Save", primary: true, value: () => ({ ok: 1 }) }]);
  if (res && res.ok) runOps([{ type: "metadata", metadata: Object.fromEntries(fields.map(([k, i]) => [k, i.value])) }]);
}

/* ------------------------------------------------------------------ wiring */
function wire() {
  $("#file-open").onchange = (e) => { if (e.target.files[0]) uploadDoc(e.target.files[0]); e.target.value = ""; };
  $("#file-open2").onchange = (e) => { if (e.target.files[0]) uploadDoc(e.target.files[0]); e.target.value = ""; };
  $("#btn-home").onclick = showHome;
  $("#btn-add-image").onclick = () => { if (S.doc) addImageAt(S.current); };
  $("#btn-lock-done").onclick = () => select(null, null, null);
  $("#btn-sel-delete").onclick = () => deleteSelection();
  $("#btn-pages").onclick = () => document.body.classList.toggle("show-thumbs");
  $("#thumbs").addEventListener("click", (e) => { if (e.target.closest(".thumb") && !e.target.closest("button")) document.body.classList.remove("show-thumbs"); });
  // a tap on the grey margin around the pages deselects too
  $("#viewer").addEventListener("pointerdown", (e) => { if (S.sel && !e.target.closest(".page")) onTap(e, () => select(null, null, null)); });
  // fallback for browsers without touch-action: block panning for touches that begin while a selection is locked
  let lockedTouch = false;
  $("#viewer").addEventListener("touchstart", () => { lockedTouch = document.body.classList.contains("obj-lock"); }, { passive: true });
  $("#viewer").addEventListener("touchmove", (e) => { if (lockedTouch) e.preventDefault(); }, { passive: false });
  $("#btn-download").addEventListener("click", (e) => {
    if (!window.PDFBackend || !S.doc) return;
    e.preventDefault();
    busy(true);
    PDFBackend.download($("#btn-download").getAttribute("href")).catch((err) => toast(err.message, "error")).finally(() => busy(false));
  });
  $("#btn-blank").onclick = async () => { const d = await api("/api/docs/blank", { method: "POST" }); openDoc(d.id, d); };
  $("#m-blank").onclick = async () => { $("#more-menu").classList.add("hidden"); const d = await api("/api/docs/blank", { method: "POST" }); openDoc(d.id, d); };
  $("#btn-undo").onclick = () => undoRedo("undo");
  $("#btn-redo").onclick = () => undoRedo("redo");
  $("#btn-zoom-in").onclick = () => setZoom(S.zoom * 1.2);
  $("#btn-zoom-out").onclick = () => setZoom(S.zoom / 1.2);
  $("#btn-fit").onclick = () => fitWidth(true);
  $("#btn-find").onclick = findReplace;
  $("#btn-more").onclick = (e) => { e.stopPropagation(); $("#more-menu").classList.toggle("hidden"); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#more-menu")) $("#more-menu").classList.add("hidden"); });
  $("#m-meta").onclick = () => { $("#more-menu").classList.add("hidden"); editMetadata(); };
  $("#m-flatten").onclick = () => {
    $("#more-menu").classList.add("hidden");
    if (confirm("Flatten burns form fields and annotations into the page content (they stop being editable). Continue?")) runOps([{ type: "flatten" }]);
  };
  $("#file-append").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f || !S.doc) return;
    $("#more-menu").classList.add("hidden");
    busy(true);
    try { const up = await uploadAsset(f); await runOps([{ type: "page", action: "insert_pdf", page: S.doc.page_count - 1, upload: up.id }]); }
    catch (err) { toast(err.message, "error"); } finally { busy(false); e.target.value = ""; }
  };
  $("#doc-name").onclick = async () => {
    if (!S.doc) return;
    const n = await promptText("Rename", "Name", S.doc.name);
    if (n) { S.doc = { ...S.doc, ...(await api(`/api/docs/${S.doc.id}/rename`, { body: { name: n } })) }; setDocButtons(); }
  };
  $$("#tools button[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));

  $("#viewer").addEventListener("scroll", () => requestAnimationFrame(trackCurrent), { passive: true });

  // drag & drop: PDFs open as documents; images dropped on a page are inserted there
  const prevent = (e) => { e.preventDefault(); e.stopPropagation(); };
  ["dragover", "dragenter"].forEach((ev) => document.addEventListener(ev, (e) => { prevent(e); $("#drop").classList.add("over"); }));
  document.addEventListener("dragleave", (e) => { if (!e.relatedTarget) $("#drop").classList.remove("over"); });
  document.addEventListener("drop", (e) => {
    prevent(e);
    $("#drop").classList.remove("over");
    const f = e.dataTransfer.files[0];
    if (!f) return;
    const ov = e.target.closest && e.target.closest(".overlay");
    if (S.doc && ov && f.type.startsWith("image/")) {
      const [x, y] = relPoint(e, ov);
      addImageAt(+ov.dataset.p, [x, y], f);
    } else uploadDoc(f);
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === "z" && !isTyping(e)) { e.preventDefault(); undoRedo(e.shiftKey ? "redo" : "undo"); return; }
    if (mod && e.key.toLowerCase() === "y" && !isTyping(e)) { e.preventDefault(); undoRedo("redo"); return; }
    if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); findReplace(); return; }
    if (e.key === "F3") { e.preventDefault(); gotoHit(S.search.idx + (e.shiftKey ? -1 : 1)); return; }
    if (isTyping(e) || !S.doc) return;
    if (e.key === "Escape") { closeEditor(); select(null, null, null); if (S.tool !== "select") setTool("select"); }
    if ((e.key === "Delete" || e.key === "Backspace") && S.sel) { e.preventDefault(); deleteSelection(); }
    if (e.key === "Enter" && S.sel && S.sel.kind === "text") { e.preventDefault(); openEditor({ mode: "edit", page: S.sel.page, run: findObj(S.sel.page, "text", S.sel.id) }); }
    const k = e.key.toLowerCase();
    if (!mod && k === "v") setTool("select");
    if (!mod && k === "t") setTool("text");
    if (!mod && k === "i") { e.preventDefault(); addImageAt(S.current); }
  });
}

wire();
setTool("select");
const m = location.hash.match(/doc=([a-f0-9]{12})/);
if (m) openDoc(m[1]); else showHome();
