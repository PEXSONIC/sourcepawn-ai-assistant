#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build a single searchable JSON dataset of entities from FGD files.

currently expects folder contents (CS:S):
  - base.fgd
  - halflife2.fgd
  - cstrike.fgd

but could be updated for any game.

key behaviors:
- parses each FGD separately; uses valvefgd to resolve inheritance/IO.
- iterates ONLY the entities defined in that file (fgd._entities) so we can
  track 'defined_in' precisely.
- merges docs by entity name across all three files.
- outputs a flat JSON array suitable for assistant's existing tool-calling
  search (includes a 'params' alias = properties).

Usage:
  python css_ents_to_json.py -i ./fgd -o ./public/css_ents.json --pretty
"""

from __future__ import annotations
import argparse
import json
import os
import sys
from typing import Any, Dict, List

# --- (pip install valvefgd) ---
try:
    from valvefgd.parser import FgdParse  
except Exception:
    try:
        from parser import FgdParse  # type: ignore
    except Exception as e:
        print("ERROR: cannot import valvefgd. Install 'valvefgd' or place parser.py next to this script.", file=sys.stderr)
        raise

FGD_FILENAMES = ("base.fgd", "halflife2.fgd", "cstrike.fgd")

def _norm_args(args) -> List[str]:
    if not args:
        return []
    out = []
    for a in args:
        s = str(a)
        if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
            s = s[1:-1]
        out.append(s)
    return out

def _entity_to_doc(entity, defined_in_rel: str) -> Dict[str, Any]:
    # parents by name (resolved via valvefgd)
    parents = [p.name for p in getattr(entity, "parents", [])]

    # definitions (e.g., base(), studio(), size(), etc.)
    defs = []
    for d in (entity.definitions or []):
        defs.append({"name": d.get("name"), "args": _norm_args(d.get("args"))})

    # merged properties/IO/spawnflags via schema views (inheritance-aware)
    props = []
    for p in entity.properties_schema:
        rec: Dict[str, Any] = {
            "name": p.get("name"),
            "type": p.get("type"),
            "description": p.get("description"),
            "default": p.get("default_value"),
            "display_name": p.get("display_name"),
            "readonly": p.get("readonly"),
            "report": p.get("report"),
        }
        if p.get("choices"):
            rec["choices"] = [{"value": c.get("value"), "display_name": c.get("display_name")} for c in p["choices"]]
        props.append(rec)

    inputs  = [{"name": i.get("name"), "type": i.get("type"), "description": i.get("description")} for i in entity.inputs_schema]
    outputs = [{"name": o.get("name"), "type": o.get("type"), "description": o.get("description")} for o in entity.outputs_schema]
    sflags  = [{"value": s.get("value"), "display_name": s.get("display_name"), "default_value": s.get("default_value")} for s in entity.spawnflags_schema]

    try:
        full_decl = entity.fgd_str()
    except Exception:
        full_decl = None

    doc = {
        "name": entity.name,
        "type": "entity",
        "class_type": entity.class_type,
        "comment": entity.description,
        "defined_in": defined_in_rel,     # the file this declaration came from
        "source_files": [defined_in_rel], # will be unioned on merge
        "parents": parents,
        "definitions": defs,
        "properties": props,
        "params": list(props),            # alias for your search scorer
        "inputs": inputs,
        "outputs": outputs,
        "spawnflags": sflags,
        "full_declaration": full_decl,
        "tags": {"class_type": entity.class_type, "game": "css"},
        "summary": (entity.description or "").split("\n", 1)[0][:200],
    }
    return doc

def _merge_docs(dst: Dict[str, Any], src: Dict[str, Any]) -> Dict[str, Any]:
    # union of source files
    dst["source_files"] = sorted(set(dst.get("source_files", [])) | set(src.get("source_files", [])))

    # keep first 'defined_in' unless absent
    if not dst.get("defined_in") and src.get("defined_in"):
        dst["defined_in"] = src["defined_in"]

    # prefer the richer non-empty description
    if (not dst.get("comment")) and src.get("comment"):
        dst["comment"] = src["comment"]
        dst["summary"] = src.get("summary", dst.get("summary"))

    # parents union
    dst["parents"] = sorted(set(dst.get("parents", [])) | set(src.get("parents", [])))

    # class_type (keep existing unless missing)
    if not dst.get("class_type") and src.get("class_type"):
        dst["class_type"] = src["class_type"]

    # definitions: dedupe by (name,args)
    seen = set()
    defs = []
    for d in (dst.get("definitions", []) + src.get("definitions", [])):
        key = (d.get("name"), tuple(d.get("args") or []))
        if key not in seen:
            defs.append(d); seen.add(key)
    dst["definitions"] = defs

    # properties by name (src overrides)
    by_name = {p.get("name"): p for p in dst.get("properties", []) if p.get("name")}
    for p in src.get("properties", []):
        if p.get("name"):
            by_name[p["name"]] = p
    props = list(by_name.values())
    dst["properties"] = props
    dst["params"] = list(props)

    # inputs: keep earliest (FGD semantics)
    inp = {i.get("name"): i for i in dst.get("inputs", []) if i.get("name")}
    for i in src.get("inputs", []):
        nm = i.get("name")
        if nm and nm not in inp:
            inp[nm] = i
    dst["inputs"] = list(inp.values())

    # outputs: allow duplicates by signature; dedupe exact triples
    out_seen = set()
    outs: List[Dict[str, Any]] = []
    for o in dst.get("outputs", []) + src.get("outputs", []):
        sig = (o.get("name"), o.get("type"), o.get("description"))
        if sig not in out_seen:
            outs.append(o); out_seen.add(sig)
    dst["outputs"] = outs

    # spawnflags by value (src overrides)
    sf = {s.get("value"): s for s in dst.get("spawnflags", []) if s.get("value") is not None}
    for s in src.get("spawnflags", []):
        val = s.get("value")
        if val is not None:
            sf[val] = s
    dst["spawnflags"] = list(sf.values())

    # keep an existing declaration; fill if missing
    if not dst.get("full_declaration") and src.get("full_declaration"):
        dst["full_declaration"] = src["full_declaration"]

    # tag union
    dst.setdefault("tags", {}).update(src.get("tags", {}))
    return dst

def _resolve_paths(root: str) -> List[str]:
    # prioritize the three canonical files if present; otherwise include all *.fgd
    wanted = [os.path.join(root, fn) for fn in FGD_FILENAMES]
    files = [p for p in wanted if os.path.isfile(p)]
    if files:
        return files
    # fallback: scan directory
    out = []
    for dirpath, _, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower().endswith(".fgd"):
                out.append(os.path.join(dirpath, fn))
    return sorted(out)

def main():
    ap = argparse.ArgumentParser(description="Merge CS:S FGDs (base/halflife2/cstrike) into a single searchable JSON.")
    ap.add_argument("-i", "--input", required=True, help="Directory that contains base.fgd, halflife2.fgd, cstrike.fgd")
    ap.add_argument("-o", "--output", required=True, help="Output JSON file (e.g., public/fgd_entities.json)")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON")
    args = ap.parse_args()

    root = os.path.abspath(args.input)
    files = _resolve_paths(root)
    if not files:
        print(f"no .fgd files found under {root}", file=sys.stderr)
        sys.exit(2)

    by_entity: Dict[str, Dict[str, Any]] = {}
    for path in files:
        rel = os.path.relpath(path, root)
        try:
            fgd = FgdParse(path)
        except Exception as e:
            print(f"[skip] {rel}: {e}", file=sys.stderr)
            continue

        # iterate only entities defined in THIS file for accurate defined_in/source_files
        entities = getattr(fgd, "_entities", None)
        if entities is None:
            # fallback if internals differ; this will over-attribute 'defined_in'
            entities = fgd.entities

        for ent in entities:
            doc = _entity_to_doc(ent, defined_in_rel=rel)
            name = doc["name"]
            if name in by_entity:
                by_entity[name] = _merge_docs(by_entity[name], doc)
            else:
                by_entity[name] = doc

    docs = sorted(by_entity.values(), key=lambda d: d["name"].lower())

    out_path = os.path.abspath(args.output)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        if args.pretty:
            json.dump(docs, f, ensure_ascii=False, indent=2)
        else:
            json.dump(docs, f, ensure_ascii=False, separators=(",", ":"))

    print(f"Wrote {len(docs)} entities → {out_path}")

if __name__ == "__main__":
    main()
