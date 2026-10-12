"""Document storage, versioning and request handlers, independent of any web framework.

Used by `server.py` (FastAPI, local hosting) and by `web/webapi.py` (Pyodide in the browser).
Handlers return JSON-able values or `Binary`; errors are raised as `ApiError(status, detail)`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
import uuid
from collections import OrderedDict
from pathlib import Path
from urllib.parse import quote

import pymupdf as fitz

import pdfcore as pc

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("PDF_EDITOR_DATA", ROOT / "data"))
DOCS = DATA / "docs"
UPLOADS = Path(os.environ.get("PDF_EDITOR_UPLOADS", DATA / "uploads"))
for d in (DOCS, UPLOADS):
    d.mkdir(parents=True, exist_ok=True)
MAX_VERSIONS = int(os.environ.get("PDF_EDITOR_MAX_VERSIONS", "60"))

_locks: dict[str, threading.Lock] = {}
_open_cache: "OrderedDict[tuple[str, int], fitz.Document]" = OrderedDict()
cache_lock = threading.Lock()  # MuPDF documents are not thread-safe


class ApiError(Exception):
    def __init__(self, status: int, detail, payload: dict | None = None):
        super().__init__(str(detail))
        self.status, self.detail, self.payload = status, detail, payload


class Binary:
    def __init__(self, data: bytes, media_type: str, filename: str | None = None):
        self.data, self.media_type, self.filename = data, media_type, filename

    def disposition(self) -> str | None:
        return f"attachment; filename*=UTF-8''{quote(self.filename)}" if self.filename else None


# ----------------------------------------------------------------------------- storage
def _lock(doc_id: str) -> threading.Lock:
    return _locks.setdefault(doc_id, threading.Lock())


def _dir(doc_id: str) -> Path:
    if not re.fullmatch(r"[a-f0-9]{12}", doc_id):
        raise ApiError(404, "no such document")
    d = DOCS / doc_id
    if not d.exists():
        raise ApiError(404, "no such document")
    return d


def _state(doc_id: str) -> dict:
    return json.loads((_dir(doc_id) / "state.json").read_text())


def _save_state(doc_id: str, st: dict):
    p = _dir(doc_id) / "state.json"
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(st))
    tmp.replace(p)


def _vpath(doc_id: str, ver: int) -> Path:
    return DOCS / doc_id / f"v{ver:05d}.pdf"


def _current(st: dict) -> int:
    return st["versions"][st["pos"]]


def _open(doc_id: str, ver: int) -> fitz.Document:
    key = (doc_id, ver)
    with cache_lock:
        if key in _open_cache:
            _open_cache.move_to_end(key)
            return _open_cache[key]
        p = _vpath(doc_id, ver)
        if not p.exists():
            raise ApiError(404, "no such version")
        doc = fitz.open(p)
        _open_cache[key] = doc
        while len(_open_cache) > 12:
            _open_cache.popitem(last=False)[1].close()
        return doc


def summary(doc_id: str) -> dict:
    st = _state(doc_id)
    ver = _current(st)
    doc = _open(doc_id, ver)
    return {
        "id": doc_id, "name": st["name"], "version": ver,
        "can_undo": st["pos"] > 0, "can_redo": st["pos"] < len(st["versions"]) - 1,
        "updated": st.get("updated"), **pc.doc_meta(doc),
    }


def _write_version(doc_id: str, st: dict, doc: fitz.Document) -> int:
    ver = st["next"]
    doc.save(_vpath(doc_id, ver), garbage=1, deflate=True)
    st["next"] += 1
    # drop redo branch
    for v in st["versions"][st["pos"] + 1:]:
        _vpath(doc_id, v).unlink(missing_ok=True)
    st["versions"] = st["versions"][: st["pos"] + 1] + [ver]
    while len(st["versions"]) > MAX_VERSIONS:
        _vpath(doc_id, st["versions"].pop(0)).unlink(missing_ok=True)
    st["pos"] = len(st["versions"]) - 1
    st["updated"] = time.time()
    _save_state(doc_id, st)
    return ver


def _new_doc(name: str, doc: fitz.Document) -> str:
    doc_id = uuid.uuid4().hex[:12]
    (DOCS / doc_id).mkdir()
    st = {"name": name, "versions": [], "pos": -1, "next": 1, "created": time.time(), "updated": time.time()}
    _save_state(doc_id, st)
    _write_version(doc_id, st, doc)
    return doc_id


# ----------------------------------------------------------------------------- handlers
def list_docs() -> list[dict]:
    out = []
    for d in DOCS.iterdir():
        try:
            st = json.loads((d / "state.json").read_text())
            out.append({"id": d.name, "name": st["name"], "updated": st.get("updated"), "versions": len(st["versions"])})
        except Exception:
            continue
    return sorted(out, key=lambda x: -(x["updated"] or 0))


def upload_doc(name: str | None, data: bytes, password: str = "") -> dict:
    name = name or "document.pdf"
    try:
        doc = fitz.open(stream=data, filetype=None if not name.lower().endswith(".pdf") else "pdf")
    except Exception as e:
        raise ApiError(400, f"cannot open file: {e}")
    if not doc.is_pdf:  # images, XPS, EPUB, ... -> convert
        try:
            doc = fitz.open("pdf", doc.convert_to_pdf())
            name = os.path.splitext(name)[0] + ".pdf"
        except Exception as e:
            raise ApiError(400, f"not convertible to PDF: {e}")
    if doc.needs_pass:
        if not password or not doc.authenticate(password):
            err = "password required" if not password else "wrong password"
            raise ApiError(401, err, {"needs_password": True, "error": err})
        doc = fitz.open("pdf", doc.tobytes(encryption=fitz.PDF_ENCRYPT_NONE))
    if doc.page_count == 0:
        raise ApiError(400, "document has no pages")
    return summary(_new_doc(name, doc))


def blank_doc(width: float = 595.28, height: float = 841.89) -> dict:
    doc = fitz.open()
    doc.new_page(width=width, height=height)
    return summary(_new_doc("untitled.pdf", doc))


def delete_doc(doc_id: str) -> dict:
    d = _dir(doc_id)
    with cache_lock:
        for k in [k for k in _open_cache if k[0] == doc_id]:
            _open_cache.pop(k).close()
    shutil.rmtree(d)
    return {"ok": True}


def rename_doc(doc_id: str, body: dict) -> dict:
    with _lock(doc_id):
        st = _state(doc_id)
        st["name"] = str(body.get("name") or st["name"])[:200]
        _save_state(doc_id, st)
    return summary(doc_id)


def render(doc_id: str, ver: int, pno: int, scale: float = 1.5) -> Binary:
    scale = max(0.1, min(scale, 6.0))
    doc = _open(doc_id, ver)
    if not 0 <= pno < doc.page_count:
        raise ApiError(404, "no such page")
    with cache_lock:
        pix = doc[pno].get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False, annots=True)
        png = pix.tobytes("png")
    return Binary(png, "image/png")


def objects(doc_id: str, ver: int, pno: int) -> dict:
    doc = _open(doc_id, ver)
    if not 0 <= pno < doc.page_count:
        raise ApiError(404, "no such page")
    with cache_lock:
        return pc.page_objects(doc, pno)


def search(doc_id: str, q: str, match_case: bool = False) -> dict:
    st = _state(doc_id)
    doc = _open(doc_id, _current(st))
    hits = []
    with cache_lock:
        for p in doc:
            flags = 0 if not match_case else fitz.TEXT_PRESERVE_WHITESPACE
            for r in p.search_for(q, flags=flags):
                hits.append({"page": p.number, "rect": pc.to_disp_rect(p, r)})
                if len(hits) >= 2000:
                    break
    return {"hits": hits}


def apply_ops(doc_id: str, version: int, ops: list[dict]) -> dict:
    with _lock(doc_id):
        st = _state(doc_id)
        cur = _current(st)
        if version != cur:
            raise ApiError(409, "document changed in another tab; reload")
        doc = fitz.open(_vpath(doc_id, cur))  # private copy to mutate
        notes: list[str] = []
        uploads = {}
        for op in ops:
            uid = op.get("upload")
            if uid:
                up = UPLOADS / re.sub(r"[^a-f0-9]", "", uid)
                if not up.exists():
                    raise ApiError(400, "upload expired; choose the file again")
                uploads[uid] = up.read_bytes()
        try:
            for op in ops:
                pc.apply_op(doc, op, notes, uploads)
        except pc.OpError as e:
            raise ApiError(400, str(e))
        except Exception as e:  # keep the server alive and the history intact
            raise ApiError(500, f"{type(e).__name__}: {e}")
        _write_version(doc_id, st, doc)
        doc.close()
    return {**summary(doc_id), "notes": list(dict.fromkeys(notes))[:8]}


def undo(doc_id: str) -> dict:
    with _lock(doc_id):
        st = _state(doc_id)
        if st["pos"] > 0:
            st["pos"] -= 1
            _save_state(doc_id, st)
    return summary(doc_id)


def redo(doc_id: str) -> dict:
    with _lock(doc_id):
        st = _state(doc_id)
        if st["pos"] < len(st["versions"]) - 1:
            st["pos"] += 1
            _save_state(doc_id, st)
    return summary(doc_id)


def download(doc_id: str, optimize: bool = True) -> Binary:
    st = _state(doc_id)
    doc = fitz.open(_vpath(doc_id, _current(st)))
    if optimize:
        try:
            doc.subset_fonts()
        except Exception:
            pass
    data = doc.tobytes(garbage=3, deflate=True, clean=False)
    name = st["name"] if st["name"].lower().endswith(".pdf") else st["name"] + ".pdf"
    stem = os.path.splitext(name)[0]
    return Binary(data, "application/pdf", f"{stem}-edited.pdf")


def upload_asset(data: bytes) -> dict:
    if len(data) > 200 * 1024 * 1024:
        raise ApiError(413, "file too large")
    uid = uuid.uuid4().hex
    (UPLOADS / uid).write_bytes(data)
    # tidy uploads older than a day
    now = time.time()
    for f in UPLOADS.iterdir():
        if now - f.stat().st_mtime > 86400:
            f.unlink(missing_ok=True)
    info = {"id": uid, "size": len(data)}
    try:
        pix = fitz.Pixmap(data)
        info.update(width=pix.width, height=pix.height)
    except Exception:
        pass
    return info
