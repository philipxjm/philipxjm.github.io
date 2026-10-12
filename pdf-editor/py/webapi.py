"""Routes the editor's /api requests to `service` inside Pyodide (the browser build).

`handle()` mirrors the routes in server.py and returns (status, media_type, body, filename),
where body is a JSON string or bytes.
"""
from __future__ import annotations

import json
import re

import service as svc

DOC = r"/api/docs/(?P<doc>[^/]+)"
ROUTES = [
    ("GET", r"/api/docs", lambda m, q, b, f: svc.list_docs()),
    ("POST", r"/api/docs", lambda m, q, b, f: svc.upload_doc(f["name"], f["data"], (b or {}).get("password", ""))),
    ("POST", r"/api/docs/blank", lambda m, q, b, f: svc.blank_doc(float(q.get("width", 595.28)), float(q.get("height", 841.89)))),
    ("GET", DOC, lambda m, q, b, f: svc.summary(m["doc"])),
    ("DELETE", DOC, lambda m, q, b, f: svc.delete_doc(m["doc"])),
    ("POST", DOC + r"/rename", lambda m, q, b, f: svc.rename_doc(m["doc"], b or {})),
    ("GET", DOC + r"/v/(?P<ver>\d+)/page/(?P<pno>\d+)\.png",
     lambda m, q, b, f: svc.render(m["doc"], int(m["ver"]), int(m["pno"]), float(q.get("scale", 1.5)))),
    ("GET", DOC + r"/v/(?P<ver>\d+)/page/(?P<pno>\d+)/objects",
     lambda m, q, b, f: svc.objects(m["doc"], int(m["ver"]), int(m["pno"]))),
    ("GET", DOC + r"/search", lambda m, q, b, f: svc.search(m["doc"], q.get("q", ""), q.get("match_case") == "true")),
    ("POST", DOC + r"/ops", lambda m, q, b, f: svc.apply_ops(m["doc"], int(b["version"]), list(b["ops"]))),
    ("POST", DOC + r"/undo", lambda m, q, b, f: svc.undo(m["doc"])),
    ("POST", DOC + r"/redo", lambda m, q, b, f: svc.redo(m["doc"])),
    ("GET", DOC + r"/download", lambda m, q, b, f: svc.download(m["doc"], q.get("optimize", "true") != "false")),
    ("POST", r"/api/uploads", lambda m, q, b, f: svc.upload_asset(f["data"])),
]
MUTATING = {"POST", "DELETE"}


def handle(method: str, path: str, query: dict, body_json: str | None, file_name: str | None, file_data):
    """file_data is a JS Uint8Array proxy (or None)."""
    body = json.loads(body_json) if body_json else None
    f = {"name": file_name, "data": bytes(file_data.to_py()) if file_data is not None else None}
    for meth, pat, fn in ROUTES:
        if meth != method:
            continue
        m = re.fullmatch(pat, path)
        if not m:
            continue
        try:
            out = fn(m.groupdict(), query, body, f)
        except svc.ApiError as e:
            return e.status, "application/json", json.dumps(e.payload or {"detail": e.detail}), None
        except (KeyError, ValueError, TypeError) as e:
            return 422, "application/json", json.dumps({"detail": f"bad request: {e}"}), None
        if isinstance(out, svc.Binary):
            return 200, out.media_type, out.data, out.filename
        return 200, "application/json", json.dumps(out), None
    return 404, "application/json", json.dumps({"detail": "not found"}), None
