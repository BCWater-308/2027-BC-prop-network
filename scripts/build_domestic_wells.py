"""Ingest the LWA domestic-well shapefile and spatial-join each well to our
2027 three-zone polygons for the §5.3 MT-sensitivity feature.

Source: domestic_wells_WyC_final_4326/  (EPSG:4326 point shapefile, 1,472 wells)

This REPLACES the older cosmo-sourced domestic-well pipeline
(scripts/fetch_cosmo_domestic_wells.py). The shapefile already carries an
MA / RMS WELL / MT assignment, but we intentionally ignore those and re-derive
`our_polygon` by point-in-polygon against our own 26 three-zone polygons, so
the well→polygon mapping stays consistent with the rest of the dashboard.

We map the shapefile attributes to the schema the dashboard consumes
(js/main.js reads `DOMESTIC_WELLS` and needs lat/lon, well_bottom_amsl,
local_gse, include):

    wid, lat, lon, install_date, well_depth, local_gse, well_bottom_amsl,
    perf_top_amsl, perf_bot_amsl, include, accuracy

We add (same as the old pipeline):
    our_polygon    — zone_label of the containing 2027 three-zone polygon
                     (point-in-polygon), or None if outside all of them.
    our_mgmt_area  — short name of that polygon (North / Chico / South)

Outputs:
    data/domestic_wells.json         — pruned + spatial-joined
    js/domestic-wells-data.js        — dashboard bundle: `const DOMESTIC_WELLS = [...]`
"""
from __future__ import annotations

import json
from pathlib import Path

import geopandas as gpd
from shapely.geometry import shape

ROOT = Path(__file__).resolve().parent.parent
SHP_IN = ROOT / "domestic_wells_WyC_final_4326" / "domestic_wells_WyC_final_4326.shp"
POLYGONS_GEOJSON = ROOT / "data" / "vina_2027_thiessen_three_zone.geojson"
JSON_OUT = ROOT / "data" / "domestic_wells.json"
JS_OUT = ROOT / "js" / "domestic-wells-data.js"

# Map shapefile column -> output schema field.  Geometry drives lat/lon.
COL_MAP = {
    "WCRNUMBER": "wid",
    "inst_year": "install_date",
    "well_depth": "well_depth",
    "GSE": "local_gse",
    "well_botto": "well_bottom_amsl",   # ESRI-truncated well_bottom_amsl
    "perf_top_a": "perf_top_amsl",
    "perf_bot_a": "perf_bot_amsl",
    "LLACCURACY": "accuracy",
}


def load_polygons():
    """Return [(zone_label, mgmt_area_short, geom)] for our 26 polygons.

    buffer(0) cleans any minor topology issues (slivers / near-zero dangles)
    from the clip without meaningfully changing geometry.
    """
    fc = json.loads(POLYGONS_GEOJSON.read_text())
    out = []
    for feat in fc["features"]:
        props = feat["properties"]
        geom = shape(feat["geometry"])
        if not geom.is_valid:
            geom = geom.buffer(0)
        out.append((props["zone_label"], props.get("mgmt_area"), geom))
    return out


def clean(v):
    """JSON-safe scalar: convert numpy types, turn NaN into None."""
    if v is None:
        return None
    try:
        import math
        if isinstance(v, float) and math.isnan(v):
            return None
    except Exception:
        pass
    if hasattr(v, "item"):          # numpy scalar
        v = v.item()
    return v


def main() -> None:
    gdf = gpd.read_file(SHP_IN)
    if gdf.crs is None or gdf.crs.to_epsg() != 4326:
        gdf = gdf.to_crs("EPSG:4326")
    print(f"Read {len(gdf):,} wells from {SHP_IN.name} (CRS={gdf.crs})")

    polys = load_polygons()
    print(f"Loaded {len(polys)} three-zone polygons for spatial join")

    out = []
    by_polygon: dict[str | None, int] = {}
    n_dropped_geom = 0
    for _, row in gdf.iterrows():
        geom = row.geometry
        if geom is None or geom.is_empty:
            n_dropped_geom += 1
            continue
        lon, lat = geom.x, geom.y

        match_label = match_ma = None
        for zone_label, mgmt_area_short, poly in polys:
            if poly.covers(geom):
                match_label, match_ma = zone_label, mgmt_area_short
                break

        rec = {out_key: clean(row.get(src)) for src, out_key in COL_MAP.items()}
        rec["lat"] = float(lat)
        rec["lon"] = float(lon)
        # `include` keep-flag: shapefile active2 is 1/0; fall back to active1 text.
        inc = clean(row.get("active2"))
        if inc is None:
            inc = 1 if str(row.get("active1", "")).strip().lower() == "active" else 0
        rec["include"] = int(inc)
        rec["our_polygon"] = match_label
        rec["our_mgmt_area"] = match_ma
        out.append(rec)
        by_polygon[match_label] = by_polygon.get(match_label, 0) + 1

    kept_active = sum(1 for r in out if r["include"] == 1)
    print(f"\n  kept {len(out):,} wells (dropped {n_dropped_geom} with no geometry)")
    print(f"  include=1 (active):      {kept_active}")
    print(f"  outside all 26 polygons: {by_polygon.get(None, 0)}")

    print("\n  by polygon (top 10):")
    items = sorted(((k, v) for k, v in by_polygon.items() if k), key=lambda x: -x[1])
    for k, v in items[:10]:
        print(f"    {k:<24} {v:>5}")

    JSON_OUT.parent.mkdir(parents=True, exist_ok=True)
    JSON_OUT.write_text(json.dumps(out, indent=2))
    print(f"\nWrote {JSON_OUT}")

    JS_OUT.parent.mkdir(parents=True, exist_ok=True)
    JS_OUT.write_text(
        "// Auto-generated by scripts/build_domestic_wells.py - do not edit by hand.\n"
        f"// Source: {SHP_IN.relative_to(ROOT).as_posix()}\n"
        "// Pruned to dashboard-relevant fields + spatial-joined against our\n"
        "// 2027 three-zone polygons (each well's `our_polygon` field is the\n"
        "// zone_label of the containing 2027 polygon, or null if outside the\n"
        "// 26-polygon coverage). `our_mgmt_area` is the short name (North /\n"
        "// Chico / South) for color/legend purposes.\n\n"
        "const DOMESTIC_WELLS = " + json.dumps(out) + ";\n"
    )
    print(f"Wrote {JS_OUT} ({JS_OUT.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
