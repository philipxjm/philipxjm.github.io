/* Browser-only backend: answers the editor's /api requests from a Web Worker running PyMuPDF
 * (Pyodide), so no server is needed. Loaded before app.js; app.js uses window.PDFBackend when present.
 */
(function () {
  const banner = document.createElement("div");
  banner.id = "engine-status";
  banner.innerHTML = '<div class="spinner"></div><span>Starting…</span>';
  document.body.append(banner);
  const setStatus = (text, error) => {
    banner.querySelector("span").textContent = text;
    banner.classList.toggle("error", !!error);
    banner.classList.toggle("hidden", !text);
  };

  let worker = null, seq = 0, fatal = null;
  const pending = new Map();
  const started = new Promise((resolveStart) => {
    const start = () => {
      worker = new Worker("worker.js?v=97544efc8b");
      worker.onmessage = (e) => {
        const m = e.data;
        if ("fatal" in m) {
          fatal = m.fatal;
          setStatus("The PDF engine failed to load: " + m.fatal + " Reload to try again.", true);
          for (const p of pending.values()) p.reject(new Error(fatal));
          pending.clear();
        } else if ("status" in m && !("id" in m)) setStatus(m.status);
        else { const p = pending.get(m.id); pending.delete(m.id); if (p) p.resolve(m); }
      };
      worker.onerror = (e) => { fatal = e.message || "worker error"; setStatus("The PDF engine crashed: " + fatal, true); };
      resolveStart();
    };
    // All tabs share one IndexedDB store, and each worker writes its whole copy back, so only one tab may run.
    if (navigator.locks) {
      navigator.locks.request("pdf-editor-store", { ifAvailable: true }, (lock) => {
        if (!lock) {
          setStatus("The editor is already open in another tab of this browser. Close it, then reload this one.", true);
          return;
        }
        start();
        return new Promise(() => {}); // hold the lock while this tab lives
      });
    } else start();
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  async function call(msg, transfer) {
    await started;
    if (fatal) throw new Error(fatal);
    return new Promise((resolve, reject) => {
      msg.id = ++seq;
      pending.set(msg.id, { resolve, reject });
      worker.postMessage(msg, transfer || []);
    });
  }

  async function request(path, init = {}, low = false) {
    const u = new URL(path, location.origin);
    const msg = { method: (init.method || "GET").toUpperCase(), path: u.pathname, query: Object.fromEntries(u.searchParams), body: null, low };
    const transfer = [];
    if (init.body instanceof FormData) {
      const fields = {};
      for (const [k, v] of init.body) {
        if (v instanceof Blob) { msg.fname = v.name || "file"; msg.file = new Uint8Array(await v.arrayBuffer()); transfer.push(msg.file.buffer); }
        else fields[k] = v;
      }
      msg.body = JSON.stringify(fields);
    } else if (typeof init.body === "string") msg.body = init.body;
    return call(msg, transfer);
  }

  async function fetchLike(path, init) {
    const r = await request(path, init);
    const headers = { "Content-Type": r.type };
    if (r.filename) headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + encodeURIComponent(r.filename);
    return new Response(r.body, { status: r.status, headers });
  }

  // page images: cache blob URLs by request path (paths include the version, so entries never go stale)
  const images = new Map();
  async function imageURL(path, low) {
    if (images.has(path)) { const u = images.get(path); images.delete(path); images.set(path, u); return u; }
    const r = await request(path, {}, low);
    if (r.status !== 200) throw new Error("render failed");
    const url = URL.createObjectURL(new Blob([r.body], { type: r.type }));
    images.set(path, url);
    while (images.size > 400) { const [k, u] = images.entries().next().value; images.delete(k); URL.revokeObjectURL(u); }
    return url;
  }

  async function download(path) {
    const r = await request(path);
    if (r.status !== 200) throw new Error(JSON.parse(r.body).detail || "download failed");
    const url = URL.createObjectURL(new Blob([r.body], { type: r.type }));
    const a = document.createElement("a");
    a.href = url; a.download = r.filename || "document.pdf";
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  window.PDFBackend = { fetch: fetchLike, imageURL, download };
})();
