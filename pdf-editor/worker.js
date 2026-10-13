/* Runs the editor's Python backend (pdfcore + service) in Pyodide, inside a Web Worker.
 * Documents persist in IndexedDB through an IDBFS mount at /data.
 * Messages in:  {id, method, path, query, body, fname, file, low}
 * Messages out: {id, status, type, body, filename} | {status: "<loading text>"} | {fatal}
 */
const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.29.5/full/";
const BUILD = "9b19cec8ac";
const FONTS_WHEEL = "pymupdf_fonts-1.0.5-py3-none-any.whl";
importScripts(PYODIDE + "pyodide.js");

let py = null, handle = null;
const say = (status) => postMessage({ status });

function syncfs(populate) {
  return new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
}

const ready = (async () => {
  say("Loading Python…");
  py = await loadPyodide({ indexURL: PYODIDE });
  say("Loading the PDF engine (about 20 MB the first time)…");
  await py.loadPackage(["pymupdf", "lzma", "micropip"]);
  const base = new URL("py/", self.location.href);
  const src = await Promise.all(["pdfcore.py", "service.py", "webapi.py"].map(async (f) => {
    const r = await fetch(new URL(f + "?v=" + BUILD, base));
    if (!r.ok) throw new Error(`cannot load ${f}: ${r.status}`);
    return [f, await r.text()];
  }));
  py.FS.mkdirTree("/app");
  for (const [f, text] of src) py.FS.writeFile("/app/" + f, text);
  py.FS.mkdirTree("/data");
  py.FS.mount(py.FS.filesystems.IDBFS, {}, "/data");
  await syncfs(true);
  say("Starting…");
  py.globals.set("FONTS_URL", new URL(FONTS_WHEEL, base).href);
  await py.runPythonAsync(`
import os, sys
import micropip
await micropip.install(FONTS_URL)  # extra fonts (Noto, Fira, Ubuntu, Cascadia); must precede "import pymupdf"
os.environ.update(PDF_EDITOR_DATA="/data", PDF_EDITOR_UPLOADS="/tmp/uploads", PDF_EDITOR_MAX_VERSIONS="30")
sys.path.insert(0, "/app")
import webapi
`);
  handle = py.globals.get("webapi").handle;
  say("");
})();
ready.catch((e) => postMessage({ fatal: String(e && e.message || e) }));

const queue = { hi: [], lo: [] };
let running = false;

onmessage = (e) => { (e.data.low ? queue.lo : queue.hi).push(e.data); pump(); };

async function pump() {
  if (running) return;
  running = true;
  try { await ready; } catch { running = false; return; }
  while (queue.hi.length || queue.lo.length) {
    const m = queue.hi.length ? queue.hi.shift() : queue.lo.shift();
    await run(m);
    await new Promise((r) => setTimeout(r, 0)); // let newer high-priority requests jump the queue
  }
  running = false;
}

async function run(m) {
  let out;
  try {
    const query = py.toPy(m.query || {});
    const res = handle(m.method, m.path, query, m.body ?? undefined, m.fname ?? undefined, m.file ?? undefined); // undefined -> None (null would be JsNull)
    query.destroy();
    const [status, type, body, filename] = res.toJs();
    res.destroy();
    if (status < 300 && (m.method === "POST" || m.method === "DELETE") && m.path !== "/api/uploads") await syncfs(false);
    out = { id: m.id, status, type, body, filename };
  } catch (e) {
    out = { id: m.id, status: 500, type: "application/json", body: JSON.stringify({ detail: String(e && e.message || e).split("\n").slice(-2).join(" ") }) };
  }
  postMessage(out, out.body instanceof Uint8Array ? [out.body.buffer] : []);
}
