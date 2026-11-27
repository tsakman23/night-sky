#!/usr/bin/env python3
"""Generate data/stars.json and data/constellations.json for the Night Sky app.

Inputs (downloaded beforehand; override paths with env vars):
  HYG_PATH   /tmp/hyg.csv.gz        HYG v3.6.1 star catalog (astronexus/HYG-Database)
  STEL_PATH  /tmp/stel_modern.json  Stellarium "modern" sky culture (figure lines, names)
  WIKI_TABLE /tmp/88con.html        Wikipedia "IAU designated constellations" page
Wikipedia REST page summaries are fetched once and cached in /tmp/ns-wiki/.

Run: python3 scripts/generate_data.py
"""

import csv
import gzip
import html as htmllib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, os.pardir, "data")
OUT_STARS = os.path.join(DATA_DIR, "stars.json")
OUT_CONSTELLATIONS = os.path.join(DATA_DIR, "constellations.json")

HYG_PATH = os.environ.get("HYG_PATH", "/tmp/hyg.csv.gz")
STEL_PATH = os.environ.get("STEL_PATH", "/tmp/stel_modern.json")
WIKI_TABLE = os.environ.get("WIKI_TABLE", "/tmp/88con.html")
WIKI_CACHE = os.environ.get("WIKI_CACHE", "/tmp/ns-wiki")
USER_AGENT = "night-sky-app/1.0 (personal project)"
MAG_MAX = 6.5  # naked-eye limit
PC_TO_LY = 3.26156

GREEK = {
    "Alp": "α", "Bet": "β", "Gam": "γ", "Del": "δ", "Eps": "ε", "Zet": "ζ",
    "Eta": "η", "The": "θ", "Iot": "ι", "Kap": "κ", "Lam": "λ", "Mu": "μ",
    "Nu": "ν", "Xi": "ξ", "Omi": "ο", "Pi": "π", "Rho": "ρ", "Sig": "σ",
    "Tau": "τ", "Ups": "υ", "Phi": "φ", "Chi": "χ", "Psi": "ψ", "Ome": "ω",
}
SUPERSCRIPT = str.maketrans("0123456789", "⁰¹²³⁴⁵⁶⁷⁸⁹")


def fnum(value):
    text = (value or "").strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def bayer_parts(value):
    """'Del-1' -> ('δ', '¹'); 'Alp' -> ('α', ''); Latin letters ('A', 'b') kept as-is."""
    text = (value or "").strip()
    if not text:
        return "", ""
    base, _, comp = text.partition("-")
    return GREEK.get(base, base), comp.translate(SUPERSCRIPT) if comp else ""


# ---------------------------------------------------------------- inputs

def load_hyg(path):
    """Return {hip: row} keeping the brightest row per HIP (Sun excluded)."""
    by_hip = {}
    with gzip.open(path, "rt") as f:
        for row in csv.DictReader(f):
            if row["id"] == "0" or not row["hip"].strip():
                continue
            if fnum(row["ra"]) is None or fnum(row["dec"]) is None:
                continue
            hip = int(row["hip"])
            mag = fnum(row["mag"])
            prev = by_hip.get(hip)
            if prev is None or (mag is not None and mag < (fnum(prev["mag"]) or 99)):
                by_hip[hip] = row
    return by_hip


def load_stellarium(path):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    cons = {}
    for c in data["constellations"]:
        abbr = c["id"].split()[-1]
        lines = [[p for p in line if isinstance(p, int)] for line in c.get("lines", [])]
        cons[abbr] = {"lines": lines, "english": c.get("common_name", {}).get("english", "")}
    names = {}
    for key, entries in data.get("common_names", {}).items():
        m = re.fullmatch(r"HIP (\d+)", key)
        if m and entries:
            names[int(m.group(1))] = entries[0].get("english") or entries[0].get("native", "")
    return cons, names


def parse_wikipedia_table(path):
    """Return {abbr: {"name", "genitive", "area"}} from the first table of the
    Wikipedia 'IAU designated constellations' page (cells: name, IAU abbr, NASA
    abbr, genitive, origin, creator, ..., meaning, brightest star, its mag, area)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        page = f.read()
    table = re.search(r"<table[^>]*>.*?</table>", page, re.S).group(0)
    out = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", table, re.S):
        cells = [
            htmllib.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", c))).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, re.S)
        ]
        if len(cells) < 6 or not re.fullmatch(r"[A-Z][A-Za-z]{2}", cells[1]):
            continue
        name = re.split(r"\s*/|\s*\[|\s*<", cells[0])[0].strip()
        area = fnum(cells[-1].replace(",", ""))
        out[cells[1]] = {"name": name, "genitive": re.split(r"\s*[/\[\"<]", cells[3])[0].strip(), "area": area}
    return out


def wiki_summary(name):
    """Fetch (extract, url) of the constellation's Wikipedia article, cached on disk."""
    os.makedirs(WIKI_CACHE, exist_ok=True)
    for title in (f"{name}_(constellation)", name):
        title = title.replace(" ", "_")
        cache = os.path.join(WIKI_CACHE, urllib.parse.quote(title, safe="") + ".json")
        if os.path.exists(cache):
            with open(cache, encoding="utf-8") as f:
                data = json.load(f)
        else:
            url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + urllib.parse.quote(title)
            data = None
            for attempt in range(5):
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                try:
                    with urllib.request.urlopen(req, timeout=30) as resp:
                        data = json.load(resp)
                    break
                except urllib.error.HTTPError as exc:
                    if exc.code == 404:
                        data = {"_error": 404}
                        break
                    wait = float(exc.headers.get("Retry-After") or 0) or 5 * 2 ** attempt
                    print(f"  {title}: HTTP {exc.code}, retrying in {wait:.0f}s")
                    time.sleep(wait)
                except Exception as exc:
                    print(f"  {title}: {exc}, retrying")
                    time.sleep(5 * 2 ** attempt)
            if data is None:  # transient failure: don't cache
                print(f"WARN: {title}: giving up")
                continue
            with open(cache, "w", encoding="utf-8") as f:
                json.dump(data, f)
            time.sleep(1.0)
        extract = data.get("extract", "")
        if data.get("type") == "standard" and "constellation" in extract.lower():
            return extract, data["content_urls"]["desktop"]["page"]
    return "", ""


# ---------------------------------------------------------------- build

def star_record(hip, row, stel_names):
    bayer, sup = bayer_parts(row["bayer"])
    dist = fnum(row["dist"])
    return {
        "hip": hip,
        "ra": round(float(row["ra"]), 5),
        "dec": round(float(row["dec"]), 5),
        "mag": fnum(row["mag"]),
        "ci": fnum(row["ci"]),
        "name": row["proper"].strip() or stel_names.get(hip, ""),
        "bayer": bayer,
        "bayerSup": sup,
        "flam": row["flam"].strip(),
        "con": row["con"].strip(),
        "dist": round(dist * PC_TO_LY, 1) if dist is not None and 0 < dist < 100000 else None,
        "spect": row["spect"].strip(),
    }


def main():
    hyg = load_hyg(HYG_PATH)
    stel, stel_names = load_stellarium(STEL_PATH)
    table = parse_wikipedia_table(WIKI_TABLE)
    print(f"HYG stars with HIP: {len(hyg)}; Stellarium figures: {len(stel)}; Wikipedia rows: {len(table)}")
    if set(table) != set(stel):
        print(f"WARN: abbr mismatch table-stel={set(table) - set(stel)} stel-table={set(stel) - set(table)}")

    # Constellation lines: drop HIPs with no HYG position.
    for abbr, c in stel.items():
        clean = []
        for line in c["lines"]:
            missing = [h for h in line if h not in hyg]
            if missing:
                print(f"WARN: {abbr}: dropping HIPs without HYG position {missing}")
            line = [h for h in line if h in hyg]
            if len(line) >= 2:
                clean.append(line)
        c["lines"] = clean

    line_hips = {h for c in stel.values() for line in c["lines"] for h in line}
    keep = {
        h for h, row in hyg.items()
        if (fnum(row["mag"]) is not None and fnum(row["mag"]) <= MAG_MAX) or h in line_hips
    }
    stars = [star_record(h, hyg[h], stel_names) for h in keep]
    stars.sort(key=lambda s: (s["mag"] if s["mag"] is not None else 99, s["hip"]))
    mag_of = {s["hip"]: (s["mag"] if s["mag"] is not None else 99) for s in stars}

    # Per-constellation star stats over all HYG HIP stars.
    brightest, count = {}, {}
    for h, row in hyg.items():
        con, mag = row["con"].strip(), fnum(row["mag"])
        if not con or mag is None:
            continue
        if con not in brightest or mag < brightest[con][0]:
            brightest[con] = (mag, h)
        if mag <= MAG_MAX:
            count[con] = count.get(con, 0) + 1

    ranked = sorted(table, key=lambda a: -(table[a]["area"] or 0))
    rank = {a: i + 1 for i, a in enumerate(ranked)}

    constellations, no_summary = [], []
    for abbr, t in table.items():
        c = stel.get(abbr, {"lines": [], "english": ""})
        summary, url = wiki_summary(t["name"])
        if not summary:
            no_summary.append(t["name"])
        figure = sorted({h for line in c["lines"] for h in line}, key=lambda h: (mag_of[h], h))
        constellations.append({
            "abbr": abbr,
            "name": t["name"],
            "genitive": t["genitive"],
            "meaning": c["english"],
            "area": t["area"],
            "areaRank": rank[abbr],
            "lines": c["lines"],
            "figureStars": figure,
            "brightest": brightest.get(abbr, (None, None))[1],
            "starCount": count.get(abbr, 0),
            "summary": summary,
            "wikiUrl": url,
        })
    constellations.sort(key=lambda c: c["name"])

    with open(OUT_STARS, "w", encoding="utf-8") as f:
        json.dump(stars, f, ensure_ascii=False, separators=(",", ":"))
    with open(OUT_CONSTELLATIONS, "w", encoding="utf-8") as f:
        json.dump(constellations, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {len(stars)} stars -> {OUT_STARS}")
    print(f"Wrote {len(constellations)} constellations -> {OUT_CONSTELLATIONS}")
    if no_summary:
        print(f"WARN: no Wikipedia summary for {no_summary}")

    # Checks
    star_hips = {s["hip"] for s in stars}
    problems = []
    if len(constellations) != 88:
        problems.append(f"{len(constellations)} constellations, expected 88")
    for c in constellations:
        if not c["lines"]:
            problems.append(f"{c['abbr']}: no lines")
        bad = [h for line in c["lines"] for h in line if h not in star_hips]
        if bad:
            problems.append(f"{c['abbr']}: unresolved {bad}")
        for k in ("genitive", "meaning", "area", "brightest", "summary", "wikiUrl"):
            if not c[k]:
                problems.append(f"{c['abbr']}: empty {k}")
    print("CHECKS:", "OK" if not problems else problems)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
