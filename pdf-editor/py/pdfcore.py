"""PDF editing core: extraction of editable objects and application of edit operations.

All coordinates exchanged with the UI are *display* coordinates: PDF points on the page as it
is shown (after /Rotate), origin top-left. Internally PyMuPDF works in unrotated page space,
so every rect/point crosses `page.rotation_matrix` / `page.derotation_matrix` at the boundary.
"""
from __future__ import annotations

import math
import re

import pymupdf as fitz

TEXT_FLAGS = fitz.TEXT_PRESERVE_WHITESPACE | fitz.TEXT_PRESERVE_LIGATURES | fitz.TEXT_MEDIABOX_CLIP

# span["flags"] bits (MuPDF)
F_ITALIC, F_SERIF, F_MONO, F_BOLD = 2, 4, 8, 16

# family -> (regular, bold, italic, bold-italic) builtin / pymupdf-fonts names
FAMILIES = {
    "helvetica": ("helv", "hebo", "heit", "hebi"),
    "times": ("tiro", "tibo", "tiit", "tibi"),
    "courier": ("cour", "cobo", "coit", "cobi"),
    "noto-sans": ("notos", "notosbo", "notosit", "notosbi"),
    "fira-sans": ("figo", "figbo", "figit", "figbi"),
    "ubuntu": ("ubuntu", "ubuntubo", "ubuntuit", "ubuntubi"),
    "cascadia-mono": ("cascadia", "cascadiab", "cascadiai", "cascadiabi"),
}
FAMILY_LABELS = {
    "original": "Original (match document)",
    "helvetica": "Helvetica / Arial",
    "times": "Times",
    "courier": "Courier",
    "noto-sans": "Noto Sans",
    "fira-sans": "Fira Sans",
    "ubuntu": "Ubuntu",
    "cascadia-mono": "Cascadia Mono",
}

_SERIF_HINTS = ("times", "serif", "roman", "cmr", "cmbx", "cmti", "cmsl", "georgia", "garamond", "minion",
                "palatino", "book", "cambria", "nimbusrom", "libertine", "charter", "utopia", "sabon",
                "baskerville", "caslon", "ptm", "txr", "lmroman", "stix", "nimbus rom", "tex gyre termes")
_MONO_HINTS = ("courier", "mono", "consol", "cmtt", "menlo", "inconsolata", "code", "typewriter", "lmtt")
_BOLD_HINTS = ("bold", "black", "heavy", "semibold", "demi", "cmbx", "-bd", ",bd")
_ITALIC_HINTS = ("italic", "oblique", "cmti", "cmsl", "cmmi", "-it", ",it")

_font_cache: dict[str, fitz.Font] = {}

# sign relating page /Rotate to the TextWriter morph angle that keeps new text upright on screen
UPRIGHT_SIGN = 1


class OpError(Exception):
    pass


# ----------------------------------------------------------------------------- helpers
def builtin_font(name: str) -> fitz.Font:
    if name not in _font_cache:
        _font_cache[name] = fitz.Font(name)
    return _font_cache[name]


def clean_text(s: str) -> str:
    """Recombine UTF-16 surrogate pairs MuPDF sometimes emits (math alphanumerics) and replace
    unpaired ones, so the text is valid UTF-8 / JSON."""
    if not s or not any("\ud800" <= ch <= "\udfff" for ch in s):
        return s
    return s.encode("utf-16", "surrogatepass").decode("utf-16", "replace")


def int_to_hex(c: int) -> str:
    return "#%06x" % (c & 0xFFFFFF)


def hex_to_rgb(h: str | None, default=(0, 0, 0)):
    if not h:
        return default
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(ch * 2 for ch in h)
    try:
        return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    except ValueError:
        return default


def to_disp_rect(page: fitz.Page, r) -> list[float]:
    rr = (fitz.Rect(r) * page.rotation_matrix).normalize()
    return [round(rr.x0, 2), round(rr.y0, 2), round(rr.x1, 2), round(rr.y1, 2)]


def from_disp_rect(page: fitz.Page, r) -> fitz.Rect:
    return (fitz.Rect(r) * page.derotation_matrix).normalize()


def from_disp_point(page: fitz.Page, p) -> fitz.Point:
    return fitz.Point(p) * page.derotation_matrix


def style_from_font(name: str, flags: int) -> dict:
    n = (name or "").lower()
    mono = bool(flags & F_MONO) or any(k in n for k in _MONO_HINTS)
    serif = (bool(flags & F_SERIF) or any(k in n for k in _SERIF_HINTS)) and "sans" not in n and not mono
    bold = bool(flags & F_BOLD) or any(k in n for k in _BOLD_HINTS)
    italic = bool(flags & F_ITALIC) or any(k in n for k in _ITALIC_HINTS)
    family = "courier" if mono else ("times" if serif else "helvetica")
    return {"family": family, "bold": bold, "italic": italic}


def family_font(family: str, bold: bool, italic: bool) -> fitz.Font:
    names = FAMILIES.get(family, FAMILIES["helvetica"])
    return builtin_font(names[(1 if bold else 0) + (2 if italic else 0)])


def fallback_chain(primary: fitz.Font, bold: bool, italic: bool) -> list[fitz.Font]:
    idx = (1 if bold else 0) + (2 if italic else 0)
    chain = [primary, builtin_font(FAMILIES["noto-sans"][idx]), builtin_font(FAMILIES["fira-sans"][idx])]
    for extra in ("math", "symbol1", "cjk"):
        try:
            chain.append(builtin_font(extra))
        except Exception:
            pass
    return chain


_ink_cache: dict[tuple[int, str], bool] = {}


def has_ink(font: fitz.Font, c: str) -> bool:
    """True if the font really draws something for `c`.

    Subset fonts (typical in LaTeX/Office PDFs) keep glyph slots and metrics for characters
    whose outlines were stripped, so has_glyph() can't be trusted; render the glyph instead."""
    if c.isspace():
        return True
    key = (id(font), c)
    if key in _ink_cache:
        return _ink_cache[key]
    ok = False
    if font.has_glyph(ord(c)):
        try:
            doc = fitz.open()
            page = doc.new_page(width=40, height=40)
            tw = fitz.TextWriter(page.rect)
            tw.append((8, 30), c, font=font, fontsize=24)
            tw.write_text(page)
            pix = page.get_pixmap(alpha=False, colorspace=fitz.csGRAY)
            ok = min(pix.samples) < 200
        except Exception:
            ok = False
    _ink_cache[key] = ok
    return ok


def covers(font: fitz.Font, text: str) -> bool:
    return all(has_ink(font, c) for c in set(text))


def segment_by_font(text: str, chain: list[fitz.Font]):
    """Split text into (substring, font) pieces, each char rendered by the first font that has it."""
    segs: list[list] = []
    space_font = next((f for f in chain if f.has_glyph(32)), chain[0])
    for c in text:
        f = chain[0]
        if c.isspace():
            # LaTeX/subset fonts often have no space glyph; a missing one breaks text extraction
            prev = segs[-1][1] if segs else chain[0]
            f = prev if prev.has_glyph(32) else space_font
        else:
            for k, cand in enumerate(chain):
                if (has_ink(cand, c) if k == 0 else cand.has_glyph(ord(c))):
                    f = cand
                    break
        if segs and segs[-1][1] is f:
            segs[-1][0] += c
        else:
            segs.append([c, f])
    return segs


def _norm_font(n: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (n or "").split("+", 1)[-1].lower())


def original_font(doc: fitz.Document, page: fitz.Page, span_font: str, cache: dict) -> fitz.Font | None:
    """Recreate the embedded font a span uses, if it can be extracted.

    PDF /BaseFont names and the names MuPDF reports for spans differ in spacing and suffixes
    ("DejaVu Sans Book" vs "DejaVuSans"), so match on normalised names: exact first, then prefix."""
    if span_font in cache:
        return cache[span_font]
    want = _norm_font(span_font)
    exact, prefix = [], []
    for xref, _ext, ftype, basefont, *_ in page.get_fonts(full=True):
        if ftype == "Type3":
            continue
        have = _norm_font(basefont)
        if have == want:
            exact.append(xref)
        elif have and want and (have.startswith(want) or want.startswith(have)):
            prefix.append(xref)
    found = None
    for xref in exact + prefix:
        try:
            _, ext2, _, buf = doc.extract_font(xref)
            if not buf or ext2 == "n/a":
                continue
            f = fitz.Font(fontbuffer=buf)
            if xref in exact or _norm_font(f.name).startswith(want) or want.startswith(_norm_font(f.name)[:len(want)]):
                found = f
                break
        except Exception:
            continue
    cache[span_font] = found
    return found


def write_text(page: fitz.Page, origin: fitz.Point, text: str, chain: list[fitz.Font], size: float,
               color, angle: float = 0.0, opacity: float = 1.0, line_height: float = 1.2):
    """Write (possibly multi-line) text with its first baseline starting at `origin` (unrotated
    page space). `angle` rotates the block about `origin` (degrees, PyMuPDF convention)."""
    tw = fitz.TextWriter(page.rect, opacity=opacity, color=color)
    rect = None
    for k, line in enumerate(text.split("\n")):
        pt = fitz.Point(origin.x, origin.y + k * size * line_height)
        for seg, font in segment_by_font(line, chain):
            r, pt = tw.append(pt, seg, font=font, fontsize=size)
            rect = r if rect is None else rect | r
    if rect is None:
        return None
    morph = (origin, fitz.Matrix(angle)) if abs(angle) > 0.01 else None
    tw.write_text(page, morph=morph)
    return rect


def dir_to_angle(d) -> float:
    """MuPDF line direction (cos, sin) -> TextWriter morph angle."""
    return -math.degrees(math.atan2(d[1], d[0]))


# ----------------------------------------------------------------------------- extraction
def extract_runs(page: fitz.Page) -> list[dict]:
    """Group characters into editable runs: same font/size/colour, contiguous on one line."""
    d = page.get_text("rawdict", flags=TEXT_FLAGS)
    runs: list[dict] = []
    for bi, b in enumerate(d["blocks"]):
        if b.get("type") != 0:
            continue
        for li, line in enumerate(b["lines"]):
            dx, dy = line["dir"]
            cur = None
            line_runs = []
            for s in line["spans"]:
                key = (s["font"], round(s["size"], 2), s["color"], s["flags"] & ~1)
                for ch in s["chars"]:
                    if ch["c"].isspace() and cur is not None:
                        cur["chars"].append(ch)  # spaces never split runs (they may come from a fallback font)
                        continue
                    split = cur is None or cur["key"] != key
                    if not split and cur["chars"]:
                        prev = cur["chars"][-1]
                        adv = (ch["origin"][0] - prev["origin"][0]) * dx + (ch["origin"][1] - prev["origin"][1]) * dy
                        pw = abs((prev["bbox"][2] - prev["bbox"][0]) * dx + (prev["bbox"][3] - prev["bbox"][1]) * dy)
                        if adv - pw > max(1.0 * s["size"], 3.0) or adv < -0.5 * s["size"]:
                            split = True
                    if split:
                        cur = {"key": key, "span": s, "chars": []}
                        line_runs.append(cur)
                    cur["chars"].append(ch)
            for r in line_runs:
                chars = r["chars"]
                while chars and chars[0]["c"].isspace():
                    chars = chars[1:]
                while chars and chars[-1]["c"].isspace():
                    chars = chars[:-1]
                if not chars:
                    continue
                s = r["span"]
                bbox = fitz.Rect()
                for ch in chars:
                    if not ch["c"].isspace():
                        bbox |= fitz.Rect(ch["bbox"])
                runs.append({
                    "block": bi, "line": li,
                    "text": clean_text("".join(ch["c"] for ch in chars)),
                    "bbox": bbox, "origin": fitz.Point(chars[0]["origin"]),
                    "chars": chars, "font": s["font"], "size": s["size"], "color": s["color"],
                    "flags": s["flags"], "dir": (dx, dy), "alpha": s.get("alpha", 255),
                })
    for i, r in enumerate(runs):
        r["id"] = f"t{i}"
    return runs


def _resolve_ref(doc: fitz.Document, xref: int) -> int:
    """Follow objects that are nothing but a reference to another object (left by replace_image)."""
    for _ in range(5):
        m = re.fullmatch(r"\s*(\d+)\s+0\s+R\s*", doc.xref_object(xref, compressed=True) or "")
        if not m:
            break
        xref = int(m.group(1))
    return xref


def image_name_map(page: fitz.Page) -> dict[int, tuple[str, int]]:
    """Resolved image xref -> (resource name, referencer); referencer != 0 means inside a Form XObject."""
    doc = page.parent
    out = {}
    for xref, _smask, _w, _h, _bpc, _cs, _alt, name, _filt, referencer in page.get_images(full=True):
        out.setdefault(_resolve_ref(doc, xref), (name, referencer))
    # names straight from the page's own /Resources/XObject (covers re-pointed entries)
    kind, val = doc.xref_get_key(page.xref, "Resources/XObject")
    if kind == "dict":
        for name, ref in re.findall(r"/([^\s/<>\[\]()]+)\s+(\d+)\s+0\s+R", val):
            out[_resolve_ref(doc, int(ref))] = (name, 0)
    return out


def page_objects(doc: fitz.Document, pno: int) -> dict:
    page = doc[pno]
    runs = []
    for r in extract_runs(page):
        st = style_from_font(r["font"], r["flags"])
        runs.append({
            "id": r["id"], "text": r["text"], "rect": to_disp_rect(page, r["bbox"]),
            "font": r["font"], "size": round(r["size"], 2), "color": int_to_hex(r["color"]),
            "bold": st["bold"], "italic": st["italic"], "family": st["family"],
            "line": f'{r["block"]}:{r["line"]}', "angle": round(dir_to_angle(r["dir"]) - page.rotation, 1),
        })
    images = []
    counts: dict[int, int] = {}
    for p in doc:
        for info in p.get_image_info(xrefs=True):
            if info.get("xref"):
                counts[info["xref"]] = counts.get(info["xref"], 0) + 1
    for i, info in enumerate(page.get_image_info(xrefs=True)):
        xref = info.get("xref", 0)
        images.append({
            "id": f"i{i}", "xref": xref, "rect": to_disp_rect(page, info["bbox"]),
            "width": info.get("width"), "height": info.get("height"),
            "uses": counts.get(xref, 1) if xref else 1, "inline": not xref,
        })
    widgets = []
    for w in page.widgets() or []:
        widgets.append({
            "id": f"w{w.xref}", "xref": w.xref, "name": w.field_name, "type": w.field_type_string,
            "value": w.field_value, "rect": to_disp_rect(page, w.rect),
            "choices": list(w.choice_values or []), "readonly": bool(w.field_flags & 1),
            "on_state": (w.on_state() if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON) else None),
        })
    annots = []
    for a in page.annots() or []:
        info = a.info
        annots.append({
            "id": f"a{a.xref}", "xref": a.xref, "type": a.type[1], "rect": to_disp_rect(page, a.rect),
            "content": clean_text(info.get("content", "")), "editable_content": a.type[0] in (fitz.PDF_ANNOT_TEXT, fitz.PDF_ANNOT_FREE_TEXT),
            "color": (lambda c: "#%02x%02x%02x" % tuple(int(v * 255) for v in c[:3]) if c and len(c) >= 3 else None)(a.colors.get("stroke")),
        })
    links = [{"rect": to_disp_rect(page, l["from"]), "uri": l.get("uri"), "page": l.get("page")} for l in page.get_links()]
    return {"page": pno, "runs": runs, "images": images, "widgets": widgets, "annots": annots, "links": links}


def doc_meta(doc: fitz.Document) -> dict:
    return {
        "page_count": doc.page_count,
        "pages": [{"w": round(p.rect.width, 2), "h": round(p.rect.height, 2), "rotation": p.rotation} for p in doc],
        "metadata": {k: v for k, v in (doc.metadata or {}).items() if k in ("title", "author", "subject", "keywords", "creator", "producer")},
        "has_forms": bool(doc.is_form_pdf),
        "fonts": [{"id": k, "label": v} for k, v in FAMILY_LABELS.items()],
    }


# ----------------------------------------------------------------------------- text ops
def _find(items, key, value, what):
    for it in items:
        if it[key] == value:
            return it
    raise OpError(f"{what} {value!r} not found (the page may have changed; reload)")


def _redact_rect_for_chars(chars, size) -> fitz.Rect:
    """A rect that covers the run's glyphs but stays clear of neighbouring lines/runs."""
    rect = fitz.Rect()
    for ch in chars:
        if ch["c"].isspace():
            continue
        r = fitz.Rect(ch["bbox"])
        h = r.height
        rect |= fitz.Rect(r.x0, r.y0 + 0.18 * h, r.x1, r.y1 - 0.18 * h)
    inset = min(0.35, rect.width * 0.02)
    return fitz.Rect(rect.x0 + inset, rect.y0, rect.x1 - inset, rect.y1)


def _remove_text_rects(page: fitz.Page, rects):
    for r in rects:
        if not r.is_empty:
            page.add_redact_annot(r)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                          text=fitz.PDF_REDACT_TEXT_REMOVE)


def _resolve_chain(doc, page, run, text, style, cache):
    """Pick fonts for new text. Returns (chain, note)."""
    base = style_from_font(run["font"], run["flags"]) if run else {"family": "helvetica", "bold": False, "italic": False}
    family = style.get("family") or "original"
    bold = style.get("bold", base["bold"])
    italic = style.get("italic", base["italic"])
    note = None
    if family == "original" and run is not None:
        styled_change = (bold != base["bold"]) or (italic != base["italic"])
        orig = None if styled_change else original_font(doc, page, run["font"], cache)
        if orig is not None and covers(orig, text):
            return [orig] + fallback_chain(family_font(base["family"], bold, italic), bold, italic), None
        primary = family_font(base["family"], bold, italic)
        standard = _norm_font(run["font"]).startswith(("times", "helvetica", "arial", "courier", "nimbusroman", "nimbussans", "nimbusmono", "liberation"))
        if orig is None and not styled_change and not standard:
            note = f"Original font '{run['font']}' is not reusable; used {primary.name}."
        elif orig is not None and not styled_change:
            missing = sorted({c for c in text if not has_ink(orig, c)})
            note = f"Original font '{run['font']}' lacks {''.join(missing[:8])!r}; used {primary.name}."
        return fallback_chain(primary, bold, italic), note
    fam = family if family in FAMILIES else base["family"]
    return fallback_chain(family_font(fam, bold, italic), bold, italic), note


def op_edit_text(doc, page, op, notes):
    runs = extract_runs(page)
    targets = []
    if op.get("line"):
        targets = [r for r in runs if f'{r["block"]}:{r["line"]}' == op["line"]]
        if not targets:
            raise OpError("line not found")
    else:
        targets = [_find(runs, "id", op["id"], "text run")]
    first = targets[0]
    text = op.get("text", "")
    style = op.get("style") or {}
    # resolve fonts BEFORE removing the old text: redaction drops font resources that become unused
    chain, note = (None, None) if text.strip() == "" else _resolve_chain(doc, page, first, text.replace("\n", ""), style, {})
    _remove_text_rects(page, [_redact_rect_for_chars(r["chars"], r["size"]) for r in targets])
    if chain is None:
        return
    if note:
        notes.append(note)
    size = float(style.get("size") or first["size"])
    color = hex_to_rgb(style.get("color")) if style.get("color") else fitz.sRGB_to_pdf(first["color"])
    angle = dir_to_angle(first["dir"])
    write_text(page, first["origin"], text, chain, size, color, angle=angle, opacity=first["alpha"] / 255)


def op_delete_text(doc, page, op, notes):
    runs = extract_runs(page)
    r = _find(runs, "id", op["id"], "text run")
    _remove_text_rects(page, [_redact_rect_for_chars(r["chars"], r["size"])])


def op_add_text(doc, page, op, notes):
    text = op.get("text", "")
    if not text.strip():
        return
    style = op.get("style") or {}
    size = float(style.get("size") or 12)
    family = style.get("family") or "helvetica"
    if family == "original":
        family = "helvetica"
    chain, _ = _resolve_chain(doc, page, None, text, {**style, "family": family}, {})
    asc = chain[0].ascender if chain[0].ascender else 0.8
    # op x/y = top-left of the text box in display coords; the first baseline sits asc*size below it
    origin = from_disp_point(page, (op["x"], op["y"] + asc * size))
    write_text(page, origin, text, chain, size, hex_to_rgb(style.get("color")), angle=UPRIGHT_SIGN * page.rotation,
               line_height=float(style.get("line_height") or 1.2))


def op_replace_all(doc, page_unused, op, notes):
    find, repl = op.get("find", ""), op.get("replace", "")
    if not find:
        raise OpError("nothing to find")
    flags = 0 if op.get("match_case") else re.IGNORECASE
    pat = re.compile(re.escape(find), flags)
    total = 0
    pages = range(doc.page_count) if op.get("page") is None else [op["page"]]
    for pno in pages:
        # snapshot the matching runs first, then edit each exactly once (the replacement may match too)
        targets = [(r["origin"], r["text"]) for r in extract_runs(doc[pno]) if pat.search(r["text"])]
        for origin, text in targets:
            page = doc[pno]
            hit = next((r for r in extract_runs(page) if r["text"] == text and abs(r["origin"].x - origin.x) < 0.5
                        and abs(r["origin"].y - origin.y) < 0.5), None)
            if hit is None:
                continue
            total += len(pat.findall(text))
            op_edit_text(doc, page, {"id": hit["id"], "text": pat.sub(lambda m: repl, text), "style": {}}, notes)
    notes.append(f"Replaced {total} occurrence(s).")


# ----------------------------------------------------------------------------- image ops
def image_bytes(doc: fitz.Document, xref: int) -> bytes:
    info = doc.extract_image(xref)
    if not info.get("smask") and info.get("ext") in ("jpeg", "jpg", "png", "jpx"):
        return info["image"]
    pix = fitz.Pixmap(doc, xref)
    if pix.colorspace and pix.colorspace.n not in (1, 3):
        pix = fitz.Pixmap(fitz.csRGB, pix)
    if info.get("smask"):
        try:
            pix = fitz.Pixmap(pix, fitz.Pixmap(doc, info["smask"]))
        except Exception:
            pass
    return pix.tobytes("png")


def _content_streams(page):
    return [(x, page.parent.xref_stream(x) or b"") for x in page.get_contents()]


def _single_do(page: fitz.Page, name: str):
    """Locate the unique `/name Do` in the page content streams -> (xref, match) or None."""
    pat = re.compile(rb"/" + re.escape(name.encode()) + rb"\s+Do\b")
    hits = []
    for x, data in _content_streams(page):
        for m in pat.finditer(data):
            hits.append((x, m, data))
    return hits[0] if len(hits) == 1 else None


def _image_target(doc, page, op):
    infos = page.get_image_info(xrefs=True)
    idx = int(op["id"][1:])
    if idx >= len(infos):
        raise OpError("image not found")
    info = infos[idx]
    if op.get("xref") is not None and info.get("xref", 0) != op["xref"]:
        raise OpError("image changed; reload")
    return info


def _edit_placement(doc, page, info, new_rect: fitz.Rect | None) -> bool:
    """Move/resize (or remove when new_rect is None) one placement by editing the content
    stream around its `Do` operator. Returns False if that is not safely possible."""
    xref = info.get("xref", 0)
    if not xref:
        return False
    same = [i for i in page.get_image_info(xrefs=True) if i.get("xref") == xref]
    name, referencer = image_name_map(page).get(xref, (None, None))
    if not name or referencer or len(same) != 1:
        return False
    loc = _single_do(page, name)
    if loc is None:
        return False
    sx, m, data = loc
    if new_rect is None:
        new = data[:m.start()] + data[m.end():]
    else:
        old = fitz.Rect(info["bbox"])
        if old.width <= 0 or old.height <= 0:
            return False
        # affine map old bbox -> new bbox in MuPDF page space, conjugated into the image's own space
        A = fitz.Matrix(1, 0, 0, 1, -old.x0, -old.y0) * fitz.Matrix(new_rect.width / old.width, 0, 0, new_rect.height / old.height, 0, 0) \
            * fitz.Matrix(1, 0, 0, 1, new_rect.x0, new_rect.y0)
        T = page.transformation_matrix  # PDF space -> MuPDF space
        A_pdf = T * A * ~T
        # get_image_info's transform uses a top-down image space; undo that flip to get the CTM in effect at `Do`
        M = fitz.Matrix(1, 0, 0, -1, 0, 1) * fitz.Matrix(info["transform"]) * ~T
        X = M * A_pdf * ~M
        cm = " ".join(f"{v:.6f}" for v in (X.a, X.b, X.c, X.d, X.e, X.f)).encode()
        new = data[:m.start()] + b"q " + cm + b" cm " + m.group(0) + b" Q" + data[m.end():]
    doc.update_stream(sx, new)
    return True


def _verify_rect(page, idx, want: fitz.Rect, tol=1.5) -> bool:
    infos = page.parent[page.number].get_image_info(xrefs=True)  # fresh Page: the old object caches image info
    if idx >= len(infos):
        return False
    got = fitz.Rect(infos[idx]["bbox"])
    return all(abs(a - b) <= tol for a, b in zip(got, want))


def op_move_image(doc, page, op, notes):
    info = _image_target(doc, page, op)
    new_rect = from_disp_rect(page, op["rect"])
    idx = int(op["id"][1:])
    xref = info.get("xref", 0)
    if xref:
        snapshot = [(x, d) for x, d in _content_streams(page)]
        if _edit_placement(doc, page, info, new_rect):
            if _verify_rect(page, idx, new_rect):
                return
            for x, d in snapshot:  # roll back the stream edit and use the fallback
                doc.update_stream(x, d)
        data = image_bytes(doc, xref)
        uses = [(p.number, i) for p in doc for i in p.get_image_info(xrefs=True) if i.get("xref") == xref]
        if len(uses) > 1:
            notes.append(f"This image is shared by {len(uses)} placements; others were re-inserted on top of the page.")
        others = [(pno, fitz.Rect(i["bbox"])) for pno, i in uses]
        page.delete_image(xref)
        for pno, r in others:
            if pno == page.number and r == fitz.Rect(info["bbox"]):
                continue
            doc[pno].insert_image(r, stream=data, keep_proportion=False)
        page.insert_image(new_rect, stream=data, keep_proportion=False)
        return
    # inline image: blank it out and re-insert the extracted pixels
    data = _inline_image_bytes(page, fitz.Rect(info["bbox"]))
    _blank_area(page, fitz.Rect(info["bbox"]))
    if data:
        page.insert_image(new_rect, stream=data, keep_proportion=False)


def _inline_image_bytes(page, rect):
    for b in page.get_text("dict", flags=fitz.TEXT_PRESERVE_IMAGES)["blocks"]:
        if b.get("type") == 1 and fitz.Rect(b["bbox"]).intersects(rect) and abs(fitz.Rect(b["bbox"]).x0 - rect.x0) < 1:
            return b.get("image")
    return None


def _blank_area(page, rect):
    page.add_redact_annot(rect + (0.3, 0.3, -0.3, -0.3))
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS, graphics=fitz.PDF_REDACT_LINE_ART_NONE,
                          text=fitz.PDF_REDACT_TEXT_NONE)


def op_delete_image(doc, page, op, notes):
    info = _image_target(doc, page, op)
    xref = info.get("xref", 0)
    if xref and _edit_placement(doc, page, info, None):
        return
    if xref:
        uses = [(p.number, fitz.Rect(i["bbox"])) for p in doc for i in p.get_image_info(xrefs=True) if i.get("xref") == xref]
        data = image_bytes(doc, xref)
        page.delete_image(xref)
        for pno, r in uses:
            if pno == page.number and r == fitz.Rect(info["bbox"]):
                continue
            doc[pno].insert_image(r, stream=data, keep_proportion=False)
        return
    _blank_area(page, fitz.Rect(info["bbox"]))


def op_replace_image(doc, page, op, notes, upload: bytes):
    info = _image_target(doc, page, op)
    xref = info.get("xref", 0)
    rect = fitz.Rect(info["bbox"])
    fit = op.get("fit", "stretch")
    if fit == "stretch" and xref:
        uses = sum(1 for p in doc for i in p.get_image_info(xrefs=True) if i.get("xref") == xref)
        if uses == 1:
            # swap the image data in place (keeps position and stacking order). Page.replace_image
            # is avoided: it blanks "the last content stream", which may not be its own.
            tmp = doc.new_page(-1, width=10, height=10)
            nx = tmp.insert_image(tmp.rect, stream=upload)
            doc.xref_copy(nx, xref)
            doc.delete_page(doc.page_count - 1)
            return
    # remove this placement and insert the new picture in its box
    op_delete_image(doc, page, op, notes)
    page.insert_image(rect, stream=upload, keep_proportion=(fit != "stretch"))


def op_add_image(doc, page, op, notes, upload: bytes):
    rect = from_disp_rect(page, op["rect"])
    page.insert_image(rect, stream=upload, keep_proportion=bool(op.get("keep_proportion", True)),
                      rotate=(-page.rotation) % 360)


# ----------------------------------------------------------------------------- forms & annotations
def _widget(page, xref):
    for w in page.widgets() or []:
        if w.xref == xref:
            return w
    raise OpError("form field not found")


def op_set_field(doc, page, op, notes):
    w = _widget(page, op["xref"])
    v = op.get("value")
    if w.field_type in (fitz.PDF_WIDGET_TYPE_CHECKBOX, fitz.PDF_WIDGET_TYPE_RADIOBUTTON):
        w.field_value = w.on_state() if v in (True, "true", "on", "On", "Yes", w.on_state()) else "Off"
    elif w.field_type == fitz.PDF_WIDGET_TYPE_LISTBOX and isinstance(v, list):
        w.field_value = v
    else:
        w.field_value = "" if v is None else str(v)
    w.update()


def op_delete_widget(doc, page, op, notes):
    page.delete_widget(_widget(page, op["xref"]))


def _annot(page, xref):
    for a in page.annots() or []:
        if a.xref == xref:
            return a
    raise OpError("annotation not found")


def op_delete_annot(doc, page, op, notes):
    page.delete_annot(_annot(page, op["xref"]))


def op_move_annot(doc, page, op, notes):
    a = _annot(page, op["xref"])
    try:
        a.set_rect(from_disp_rect(page, op["rect"]))
        a.update()
    except Exception as e:
        raise OpError(f"this annotation type cannot be moved ({e})")


def op_edit_annot(doc, page, op, notes):
    a = _annot(page, op["xref"])
    a.set_info(content=op.get("content", ""))
    a.update()


def _colors(op, default_stroke=(1, 0, 0)):
    stroke = hex_to_rgb(op.get("color"), default_stroke) if op.get("color", "x") is not None else None
    fill = hex_to_rgb(op["fill"]) if op.get("fill") else None
    return stroke, fill


def op_annotate(doc, page, op, notes):
    kind = op["kind"]
    stroke, fill = _colors(op)
    width = float(op.get("width", 1.5))
    opacity = float(op.get("opacity", 1.0))
    if kind in ("highlight", "underline", "strikeout", "squiggly"):
        rect = from_disp_rect(page, op["rect"])
        words = [fitz.Rect(w[:4]) for w in page.get_text("words", clip=rect)]
        quads = [w.quad for w in words] or [rect.quad]
        fn = {"highlight": page.add_highlight_annot, "underline": page.add_underline_annot,
              "strikeout": page.add_strikeout_annot, "squiggly": page.add_squiggly_annot}[kind]
        a = fn(quads)
        a.set_colors(stroke=stroke or (1, 1, 0))
    elif kind in ("rect", "ellipse"):
        rect = from_disp_rect(page, op["rect"])
        a = page.add_rect_annot(rect) if kind == "rect" else page.add_circle_annot(rect)
        a.set_colors(stroke=stroke, fill=fill)
        a.set_border(width=width)
    elif kind in ("line", "arrow"):
        p1, p2 = from_disp_point(page, op["p1"]), from_disp_point(page, op["p2"])
        a = page.add_line_annot(p1, p2)
        a.set_colors(stroke=stroke)
        a.set_border(width=width)
        if kind == "arrow":
            a.set_line_ends(fitz.PDF_ANNOT_LE_NONE, fitz.PDF_ANNOT_LE_OPEN_ARROW)
    elif kind == "ink":
        pts = [[tuple(from_disp_point(page, p)) for p in stroke_pts] for stroke_pts in op["points"] if len(stroke_pts) > 1]
        if not pts:
            return
        a = page.add_ink_annot(pts)
        a.set_colors(stroke=stroke)
        a.set_border(width=width)
    elif kind == "note":
        a = page.add_text_annot(from_disp_point(page, op["point"]), op.get("content", ""))
        if stroke:
            a.set_colors(stroke=stroke)
    else:
        raise OpError(f"unknown annotation kind {kind}")
    if opacity < 1:
        a.set_opacity(opacity)
    a.update()


def op_whiteout(doc, page, op, notes):
    rect = from_disp_rect(page, op["rect"])
    page.draw_rect(rect, color=None, fill=hex_to_rgb(op.get("fill"), (1, 1, 1)), overlay=True)


def op_redact(doc, page, op, notes):
    rect = from_disp_rect(page, op["rect"])
    page.add_redact_annot(rect, fill=hex_to_rgb(op.get("fill"), (0, 0, 0)))
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_PIXELS, graphics=fitz.PDF_REDACT_LINE_ART_REMOVE_IF_TOUCHED,
                          text=fitz.PDF_REDACT_TEXT_REMOVE)


# ----------------------------------------------------------------------------- page / document ops
def op_page(doc, page_unused, op, notes, upload: bytes | None = None):
    action, pno = op["action"], op.get("page", 0)
    if action == "rotate":
        p = doc[pno]
        p.set_rotation((p.rotation + int(op.get("degrees", 90))) % 360)
    elif action == "delete":
        if doc.page_count <= 1:
            raise OpError("cannot delete the only page")
        doc.delete_page(pno)
    elif action == "duplicate":
        doc.fullcopy_page(pno, pno + 1)
    elif action == "move":
        to = int(op["to"])
        if to < 0 or to >= doc.page_count:
            raise OpError("bad target position")
        doc.move_page(pno, to if to < pno else to + 1)
    elif action == "insert_blank":
        ref = doc[min(pno, doc.page_count - 1)].rect
        doc.new_page(pno + 1, width=ref.width, height=ref.height)
    elif action == "insert_pdf":
        if not upload:
            raise OpError("no PDF uploaded")
        src = fitz.open(stream=upload, filetype="pdf")
        doc.insert_pdf(src, start_at=pno + 1 if op.get("after", True) else pno)
    elif action == "crop":
        p = doc[pno]
        p.set_cropbox(from_disp_rect(p, op["rect"]) + (p.cropbox.x0, p.cropbox.y0, p.cropbox.x0, p.cropbox.y0))
    else:
        raise OpError(f"unknown page action {action}")


def op_metadata(doc, page_unused, op, notes):
    md = dict(doc.metadata or {})
    for k in ("title", "author", "subject", "keywords", "creator", "producer"):
        if k in op.get("metadata", {}):
            md[k] = op["metadata"][k]
    doc.set_metadata(md)


def op_flatten(doc, page_unused, op, notes):
    doc.bake(annots=bool(op.get("annots", True)), widgets=bool(op.get("widgets", True)))


PAGE_OPS = {
    "edit_text": op_edit_text, "delete_text": op_delete_text, "add_text": op_add_text,
    "move_image": op_move_image, "delete_image": op_delete_image,
    "set_field": op_set_field, "delete_widget": op_delete_widget, "delete_annot": op_delete_annot, "move_annot": op_move_annot,
    "edit_annot": op_edit_annot, "annotate": op_annotate, "whiteout": op_whiteout, "redact": op_redact,
}
UPLOAD_OPS = {"replace_image": op_replace_image, "add_image": op_add_image}
DOC_OPS = {"replace_all": op_replace_all, "metadata": op_metadata, "flatten": op_flatten}


def apply_op(doc: fitz.Document, op: dict, notes: list, uploads: dict) -> None:
    t = op.get("type")
    if t == "page":
        op_page(doc, None, op, notes, uploads.get(op.get("upload")) if op.get("upload") else None)
        return
    if t in DOC_OPS:
        DOC_OPS[t](doc, None, op, notes)
        return
    pno = int(op.get("page", 0))
    if not 0 <= pno < doc.page_count:
        raise OpError("page out of range")
    page = doc[pno]
    if t in PAGE_OPS:
        PAGE_OPS[t](doc, page, op, notes)
    elif t in UPLOAD_OPS:
        data = uploads.get(op.get("upload"))
        if not data:
            raise OpError("missing upload")
        UPLOAD_OPS[t](doc, page, op, notes, data)
    else:
        raise OpError(f"unknown op type {t!r}")
