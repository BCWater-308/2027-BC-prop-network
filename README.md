# Vina Subbasin 2027 RMS Network Dashboard

Static interactive dashboard for the 2027 Representative Monitoring Site (RMS)
network in the Vina Subbasin (DWR B118 5-021.57), Butte County, California.

Built from `BC Network 2026 v8.xlsx`.

> The current state is **26 RMS wells across 26 polygons**:
>
> - **13 North** Voronoi cells. Three of the 13 RMS wells
>   (`22N01E09B001M`, `22N01E20K001M`, `23N01E33A001M`) physically sit
>   inside the Chico mgmt area but are part of the North RMS network.
>   Their Thiessen cells are clipped to NOT overlap with Chico — the
>   cells sit north of the wells (in N proper), while the well markers
>   themselves remain inside Chico. The 11 cells whose seed wells are
>   physically in N tile the rest of the basin-minus-Chico-minus-South
>   region, absorbing any sliver between mgmt-area boundaries.
> - **1 dissolved Chico** mgmt-area polygon, with **CWSCH01b as the
>   single RMS well** for the 2027 Chico network. The 8 other
>   completions at the historical 2022 GSP nested sites — CWSCH 7-nest
>   (CWSCH02/03/04/05/06/07) and 22N01E28J 2-nest (22N01E28J001M/
>   005M) — are now supplemental, plotted in §5.3 for hydrograph context
>   but without threshold lines.
> - **12 South** Voronoi cells, clipped to South mgmt area.
>
> **Threshold methodology (revised 2026-05-21):** 9 wells are direct
> 2022 GSP carryovers (5 N, 3 S, 1 Chico = CWSCH01b); 17 wells get the
> **AGWL Mirror** thresholds — each well's average Feb–April groundwater
> level minus a per-zone offset calibrated against the 2022 GSP MT/MO/IM,
> as described in the methodology section below. The 8 Chico supplementals
> remain monitored but unthresholded.
>
> See "Source 2" below and PROJECT_NOTES for full history.

- **§5.2** — Interactive Leaflet map (basin boundary, 26 polygons,
  all 79 wells with layer toggles for 2027 RMS / supplemental).
- **§5.3** — Per-polygon hydrograph (Plotly) with MT / MO / IM-2027 threshold
  lines where the 2022 GSP carried forward, plus a per-polygon well-detail
  card and a sortable record-count table.
- **§5.4** — Same-month paired GWE scatter (1:1 line, Pearson R² in the
  legend) for representativeness comparison of supplemental wells against
  the polygon's RMS well.

## Quick start

```bash
# 1. (one-time) install Python deps used by the build scripts
pip3 install --user openpyxl pandas geopandas pyproj scipy shapely requests

# 2. (one-time per data refresh) rebuild the data files
python3 scripts/resolve_sites.py               # xlsx -> data/wells_resolved.json
python3 scripts/build_polygons_single.py       # -> data/vina_2027_thiessen_single.geojson + js/polygons-data-single.js
python3 scripts/build_polygons_three_zone.py   # -> data/vina_2027_thiessen_three_zone.geojson + js/polygons-data-three-zone.js
python3 scripts/fetch_dwr_measurements.py      # -> js/measurements-data.js (~15 MB)
python3 scripts/compute_thresholds.py          # -> data/thresholds.json
python3 scripts/build_wells_js.py              # -> js/wells-data.js
python3 scripts/build_readme_js.py             # -> js/readme-data.js (so the in-page README accordion is in sync)

# 3. open the dashboard
open index.html
```

The dashboard is pure static HTML/JS — no build step, no server. Drop it on
GitHub Pages, S3, or open `index.html` directly.

## Repo layout

```
.
├── index.html                              Dashboard shell (§5.2, §5.3, §5.4)
├── README.md                               This file (also rendered inside the dashboard)
├── BC Network 2026 v8.xlsx                 Source workbook (79 wells, RMS flags, metadata)
├── js/
│   ├── wells-data.js                       const WELLS — 79 wells joined to DWR site_code
│   ├── polygons-data-single.js             const RMS_POLYGONS_SINGLE — 26 cells (one Voronoi per 2027 RMS well), basin-wide
│   ├── polygons-data-three-zone.js         const RMS_POLYGONS_THREE_ZONE — 26 entries (13 N Voronoi cells + 1 dissolved Chico polygon + 12 S Voronoi cells)
│   ├── measurements-data.js                const MEASUREMENTS, MEASUREMENTS_META — periodic GWL
│   ├── basin-boundary.js                   const VINA_BOUNDARY — B118 5-021.57 GeoJSON
│   ├── readme-data.js                      const README_MD — this README bundled for the in-page accordion
│   └── main.js                             UI logic (Leaflet, Plotly, layer toggles, polygon-method picker)
├── data/                                   Intermediate JSON for the JS bundles
│   ├── wells_resolved.json                 Excel rows joined to DWR Stations
│   ├── thresholds.json                     MT/MO/IM-2027 for the 26 RMS wells (9 GSP carryovers + 17 AGWL Mirror); the 8 supplemental Chico nested completions are monitored but unthresholded
│   ├── thresholds_2022.json                The 17 adopted 2022 GSP MT/MO/IM values (6 N + 6 S + 4 Chico); used by compute_thresholds.py as the calibration sample for AGWL Mirror and as the carryover source for the 9 wells retained from the 2022 RMS network
│   ├── vina_2027_thiessen_single.geojson   Single-tessellation polygons as GeoJSON
│   └── vina_2027_thiessen_three_zone.geojson  Three-zone polygons as GeoJSON
├── raw/                                    Cached raw downloads (gitignored)
│   ├── stations.csv                        DWR CKAN periodic GWL Stations resource
│   ├── vina_subbasin.geojson               DWR B118 (5-021.57) boundary
│   ├── vina_management_areas.geojson       Three Vina mgmt-area polygons (input for three-zone)
│   └── b118_vina_esri.json                 Source Esri JSON before reshaping to GeoJSON
└── scripts/                                Build scripts
    ├── resolve_sites.py                    xlsx + DWR Stations -> wells_resolved.json
    ├── build_polygons_single.py            Single basin-wide tessellation (Method A below)
    ├── build_polygons_three_zone.py        Per-management-area tessellations (Method B below)
    ├── fetch_dwr_measurements.py           DWR CKAN -> measurements-data.js
    ├── compute_thresholds.py               9 GSP carryovers + 17 AGWL Mirror -> thresholds.json
    ├── build_wells_js.py                   wells_resolved + thresholds -> wells-data.js
    ├── update_workbook_thresholds.py       Appends MT/MO/IM/Source columns to xlsx
    └── build_readme_js.py                  README.md -> readme-data.js
```

## How the polygons are built

> **Counts at a glance.** Both methods produce **26 polygons** seeded from the **26 wells in the 2027 RMS network** (13 N, 1 Chico = `CWSCH01b`, 12 S).
>
> - **Single tessellation** → 26 cells, one Voronoi per 2027 RMS well clipped to the Vina Subbasin boundary.
> - **Three-zone tessellation** → 26 entries: 13 N Voronoi cells clipped to (Basin − Chico − South) + 1 dissolved Chico mgmt-area polygon + 12 S Voronoi cells clipped to South.
>
> The 8 Chico supplemental completions (CWSCH02–07 and 22N01E28J001M/005M — share the CWSCH01b and 22N01E28J pads, respectively) are not RMS in the 2027 network, so they don't seed any polygon. They appear in §5.3 hydrographs as supplemental traces for the Chico aggregate.

A Thiessen polygon (aka Voronoi cell) for a point is the locus of points in
space that are closer to that point than to any other point in the seed set.
Used in groundwater monitoring to define the area each RMS well is
**presumed** to represent.

The dashboard ships **two complete tessellations** that answer different
questions about how the basin should be partitioned. A `Polygon method`
picker at the top of §5.2 swaps between them instantly without reloading.

| Method | Output | When to use |
|---|---|---|
| **Three-zone tessellation** (default) | 26 entries: 13 N Voronoi cells + 1 dissolved Chico mgmt-area polygon + 12 S Voronoi cells. No N or S cell overlaps Chico. | SMC-defensible view: each management area carries distinct sustainability criteria, so partitioning *within* each area gives a self-contained polygon-by-polygon story. Chico's hydrogeology is better captured by treating it as a single aggregate (with CWSCH01b as the RMS well and 9 nested supplementals for context) than by Voronoi subdivision. |
| **Single tessellation** | 26 cells, one Voronoi per 2027 RMS well, all clipped to the basin boundary. | Basin-wide proximity view; useful for stakeholders who want to see which RMS well is geographically closest to any point in the basin. |

Both methods share the same foundations (Step 1 below: seeds, Step 2:
project to EPSG:3310). They diverge on the **clip boundary** (basin vs.
mgmt-area polygons) and on **how Chico is handled** (the three-zone
method dissolves Chico into one aggregate polygon; the single method
gives CWSCH01b its own Voronoi cell within the basin).

### Step 1 (shared): Pick the seeds

Read `BC Network 2026 v8.xlsx`. Keep every row where column **E (`2027 GWL
RMS?`) = "Yes"**. This yields **26 wells** — one seed per polygon — distributed by network assignment:

| RMS sites (network design) | Wells |
|-----------|-------|
| 01-Vina-North (network) | 13 — 10 physically in N + 3 physically in Chico but RMS-for-North (`22N01E09B001M`, `22N01E20K001M`, `23N01E33A001M`) |
| 02-Vina-Chico | 1 — `CWSCH01b` (8 nested-pad supplementals at the same site are not RMS in 2027 and don't seed polygons) |
| 03-Vina-South | 12 |

Coordinates come from columns **L (latitude)** and **M (longitude)**. A
`rms_mgmt_area` field in `wells_resolved.json` captures the
network-design mgmt-area assignment, which can differ from the workbook
`mgmt_area_full` (geographic). For the 2 reassigned wells
(`22N01E09B001M`, `22N01E20K001M`) `rms_mgmt_area = "01-Vina-North"`
while `mgmt_area_full` stays `"02-Vina-Chico"`.

### Step 2 (shared): Project to an equal-area metric CRS

Voronoi tessellation only behaves sensibly in a Euclidean metric. Lat/lon
degrees aren't Euclidean — a degree of longitude at 39.7° N is about 23 %
shorter than a degree of latitude. So before computing any diagram we
project both seeds and clip boundaries from **WGS-84 (EPSG:4326)** into
**NAD-83 California Albers Equal Area (EPSG:3310)** using `pyproj`.
EPSG:3310 is the standard DWR / Bulletin 118 working CRS, so polygon areas
in the dashboard match what you'd compute against the official DWR layers.

### Method A — Single tessellation

`scripts/build_polygons_single.py`.

**Clip boundary**: Vina Subbasin (`Basin_Subbasin_Number = '5-021.57'`)
pulled from the DWR ArcGIS REST service, then converted from Esri JSON to
GeoJSON locally with Shapely. Lives at `raw/vina_subbasin.geojson` — a
single Polygon with a 1,729-vertex outer ring (~184,000 acres).

**Tessellation**: `scipy.spatial.Voronoi` over all 26 RMS-well coordinates.
Four anchor points 10× the basin bounding box outside ensure every real
cell is bounded (SciPy emits open rays for hull sites otherwise). Each
finite cell is intersected with the Albers-projected basin polygon, so
cell edges along the basin perimeter follow the official B118 line.

**Export**:
- `data/vina_2027_thiessen_single.geojson` — GeoJSON FeatureCollection
- `js/polygons-data-single.js` — `const RMS_POLYGONS_SINGLE = [...]`, rings
  in `[lat, lng]` order for Leaflet

Sanity check: 26 cells total **~184,900 acres** — within 0.3% of the
published Vina Subbasin area (~184,400 acres).

### Method B — Three-zone (per-mgmt-area)

`scripts/build_polygons_three_zone.py`.

The three management areas are handled with **different polygon
strategies** that reflect how the GSA's stakeholders want each area
represented. **No polygon overlaps with the Chico management area.**

**North** — 13 wells, **Voronoi cells**, all clipped to
`(Basin − Chico mgmt area − South mgmt area)`. The Voronoi is computed
directly over that clipped domain using all 13 seeds; scipy handles
seeds that sit *outside* the clip domain correctly (their Voronoi
regions still extend into the domain wherever they're the nearest seed).
Three of the 13 RMS wells (`22N01E09B001M`, `22N01E20K001M`,
`23N01E33A001M`) physically sit inside the Chico management area; their
clipped cells therefore sit *north* of where the well markers are drawn.
The cells together tile the entire `(Basin − Chico − South)` region, so
any sliver between mgmt-area boundaries on the W and E edges is
absorbed into the adjacent N cell — no orphan slivers.

**Chico** — **one dissolved polygon** = the entire Chico mgmt area
boundary (no internal Voronoi subdivision). The single 2027 RMS well
for Chico is **CWSCH01b**; its MT/MO/IM is the 2022 GSP carryover.
The 8 supplemental well completions at the same two physical pads —
CWSCH02/03/04/05/06/07 (CWSCH pad) and 22N01E28J001M/005M
(22N01E28J pad) — are monitored but unthresholded in the 2027 network.
The dashboard renders Chico as a single §5.3 picker entry; selecting
it plots CWSCH01b's hydrograph with threshold lines plus all 8
supplemental traces for context.

**South** — 12 wells, **Voronoi cells**, clipped to the South mgmt
area.

**Drawing order** in the dashboard: the output JS array is
`[Chico, ...North, ...South]`. Leaflet draws polygons in array order,
so the Chico aggregate sits at the back of the SVG; the 13 North
cells (and 12 South cells) overlay on top. The 3 Chico-located N
wells' cells do *not* overlap with Chico (they sit north of those
wells), so there's no visible overlay in Chico mgmt area — Chico
appears as the peach mgmt-area background only.

The dashboard uses dedicated Leaflet panes (`polygonsPane` z-index 400,
`wellsPane` z-index 450) so the well markers always sit above polygons
regardless of toggle order. The well markers for the 3 Chico-located N
RMS wells appear inside Chico (their physical location); clicking them
shows a popup that calls out the "well location inside Chico mgmt area,
RMS for the North network" relationship.

**Membership**: comes from the `rms_mgmt_area` field in
`wells_resolved.json` (the network-design assignment, which can differ
from the geographic `mgmt_area_full`). For the 2 reassigned wells
(`22N01E09B001M`, `22N01E20K001M`), `rms_mgmt_area = "01-Vina-North"`
while `mgmt_area_full` stays `"02-Vina-Chico"`. Every polygon feature
also carries `workbook_mgmt_area` and `reassigned: true|false` for
the audit trail, and `well_in_chico_mgmt_area: true|false` derived
from spatial containment so the dashboard popup can call out the
3 wells whose physical location is in Chico.

**Export**:
- `data/vina_2027_thiessen_three_zone.geojson` — FeatureCollection of 26 features
- `js/polygons-data-three-zone.js` — `const RMS_POLYGONS_THREE_ZONE = [...]`
- The Chico aggregate entry carries `is_aggregate: true`,
  `rms_well_swns: [...10 SWNs]`, and a custom `rms_label` for the picker

Sanity check: total 26 entries (13 N + 1 Chico + 12 S). The 13 N
cells together cover **~72,000 ac** (= basin − Chico − South within
rounding); the Chico aggregate is **~29,700 ac** (full mgmt area); the
12 S cells are **~83,000 ac** (= full South mgmt area). N-Chico
overlap: **0 ac**.

### Per-polygon areas (post-2026-05-19+ revision)

Acres are rounded to the nearest integer. In three-zone, the 3
Chico-located N RMS wells (marked ⚑) have polygons in N (north of where
the well marker sits), not in Chico — their cell area is whatever piece
of (Basin − Chico − South) is closer to that well than any other N
seed. Both methods' totals are within rounding of 184,400 ac (the Vina
Subbasin).

| site / polygon | mgmt area (network) | acres (single) | acres (three-zone) |
|---|---|---:|---:|
| 22N01W05M001M | North | 7,541 | 7,541 |
| 23N01E07H001M | North | 8,272 | 8,272 |
| ⚑ 23N01E33A001M | North (in Chico geo) | 10,782 | 9,963 |
| 23N01W36P001M | North | 7,088 | 7,088 |
| 23N02W25C001M | North | 5,850 | 5,850 |
| 23N01E29P002M | North | 3,968 | 3,896 |
| 23N01W09E001M | North | 5,311 | 5,311 |
| 23N01W10M001M | North | 3,522 | 3,522 |
| 23N01W14R002M | North | 3,975 | 3,975 |
| 23N01W27L001M | North | 3,166 | 3,166 |
| 23N01W28M004M | North | 3,359 | 3,359 |
| ⚑ 22N01E20K001M | North (in Chico geo) | 9,997 | 8,147 |
| ⚑ 22N01E09B001M | North (in Chico geo) | 6,788 | 1,966 |
| CWSCH01b | Chico | 14,916 | (covered by Chico aggregate) |
| 02-Vina-Chico (dissolved) | Chico | — | 29,718 |
| 20N02E24C001M | South | 7,863 | 7,861 |
| 21N02E18C003M | South | 12,365 | 5,244 |
| 20N01E02H003M | South | 5,202 | 5,200 |
| 20N02E09G001M | South | 6,522 | 6,521 |
| 20N03E33L001M | South | 5,182 | 5,186 |
| 21N01E10B003M | South | 6,309 | 6,650 |
| 21N01E13L004M | South | 2,713 | 2,713 |
| 21N01E25K001M | South | 2,748 | 2,748 |
| 21N01E27D001M | South | 10,931 | 10,825 |
| 21N02E26E006M | South | 11,791 | 11,480 |
| 21N02E32E001M | South | 4,534 | 4,534 |
| 21N03E32B001M | South | 14,223 | 14,225 |

### How the dashboard chooses

`index.html` loads both `polygons-data-single.js` and
`polygons-data-three-zone.js` as siblings; `js/main.js` keeps a swappable
`RMS_POLYGONS` reference pointing at whichever set the `Polygon method`
picker has selected. Switching the picker calls `setPolygonMethod()`,
which clears and rebuilds the Leaflet polygon layer, re-populates the
§5.3 picker (the mgmt-area-prefixed label updates for the reassigned
wells), and re-selects the previously-active well if it still exists in
the new set. Both methods carry 26 keys; the only key that differs
between them is the Chico polygon — labeled `CWSCH01b` in single and
`02-Vina-Chico` in three-zone — but both reference CWSCH01b as the
underlying RMS well.

### Method-specific notes

1. **Chico aggregation.** The three-zone method dissolves Chico into a
   single mgmt-area polygon (no internal Voronoi subdivision). The
   single-tessellation method gives CWSCH01b — Chico's one 2027 RMS
   well — its own Voronoi cell within the basin boundary.
2. **Edge-case wells.** Three RMS wells in the North network physically
   sit inside the Chico mgmt area (`22N01E09B001M`, `22N01E20K001M`,
   `23N01E33A001M`). The single-tessellation method gives them
   Voronoi cells centered on their physical location; the three-zone
   method clips their cells so they sit *north* of the wells, inside
   the (Basin − Chico − South) region they represent for the North
   network. An auditable `reassigned` flag in each well record tracks
   this network-vs-geographic split.

## MT / MO / IM-2027 threshold methodology

> **Standalone memo.** A self-contained methodology explainer lives at [`analysis/methodology_mt_mo_im.md`](analysis/methodology_mt_mo_im.md). The full three-variant spring-window sensitivity comparison that informed the staff selection of Feb–April is at [`analysis/agwl_window_comparison.md`](analysis/agwl_window_comparison.md). The summary below is in sync with both.

The dashboard shows Sustainable Management Criteria (SMC) threshold lines on
every 2027 RMS well's hydrograph. Values come from one of two sources, both
expressed as **groundwater elevation in ft msl** (not depth-below-RPE):

### Source 1 — "2022 GSP" (adopted, 9 wells)

These are the **Minimum Threshold (MT)**, **Measurable Objective (MO)**,
and **Interim Milestone for 2027 (IM-2027)** values carried over
**unchanged** from the 2022 Vina GSP for the 9 wells that are in both
the 2022 and 2027 RMS networks. Rendered with **dashed** lines in §5.3
hydrographs and labeled with the "GSP-adopted MT/MO" pill in the §5.3
table.

| Well | Mgmt area | MT | MO | IM-2027 | Notes |
|---|---|---|---|---|---|
| 22N01W05M001M | North | 31 | 115 | 116 | |
| 23N01E07H001M | North | 72 | 136 | 140 | |
| 23N01E33A001M | North | 72 | 125 | 128 | well location in Chico mgmt area |
| 23N01W36P001M | North | 45 | 108 | 110 | |
| 23N02W25C001M | North | 50 | 130 | 130 | |
| 20N02E24C001M | South | 18 | 77 | 81 | |
| 21N02E18C003M | South | 65 | 130 | 132 | |
| 21N02E26E006M | South | 36 |  95 |  97 | inherits from `21N02E26E005M`, the 2022 GSP RMS at this same lat/lng (retired from 2027, different completion depth) |
| CWSCH01b | Chico | 85 | 106 | 107 | the only RMS at the Chico aggregate; 9 nested-completion supplementals plot for context but are unthresholded |

### Source 2 — "AGWL Mirror" (Feb–April AGWL methodology, 17 wells)

AGWL Mirror has been developed to faithfully recreate MT/MO/IMs for new polygons that effectively mirror what was adopted in 2022.

The other 17 wells in the 2027 RMS network were not RMS wells in 2022,
so they have no carry-over GSP values. The **AGWL Mirror** baseline
derives each well's MT/MO/IM from its own average
Feb–April groundwater level and a per-management-area offset calibrated
against the 2022 GSP MT/MO/IM. Rendered with **dotted** lines in §5.3
hydrographs and labeled with the "AGWL mirror MT/MO" pill in the §5.3
table.

#### Method

For each well in the 2022 GSP RMS network (the benchmark sample),
compute `AGWL` = mean of QA-Good GWE measurements falling in February,
March, or April months across the full DWR record. Then per management
area, compute the offset from AGWL to each of the GSP-adopted thresholds:

```
ΔGWL→MT = AGWL_RMS − MT_2022_RMS
ΔGWL→MO = AGWL_RMS − MO_2022_RMS
ΔGWL→IM = AGWL_RMS − IM_2027_RMS
```

Average each offset across the 2022 RMS wells in the zone:
`AveΔGWL_MT_zone`, `AveΔGWL_MO_zone`, `AveΔGWL_IM_zone`.

For each of the 17 new 2027 RMS wells, compute its own Feb–April
AGWL and apply the following formula:

```
MT_ft       = round(AGWL_well − AveΔGWL_MT_zone)
MO_ft       = round(AGWL_well − AveΔGWL_MO_zone)
IM_2027_ft  = round(AGWL_well − AveΔGWL_IM_zone)
```

**Zone offsets (Feb–April, ft):**

| Region | n RMS wells | avg AGWL (ft msl) | AveΔGWL→MT | AveΔGWL→MO | AveΔGWL→IM |
|---|---:|---:|---:|---:|---:|
| North | 6 | 149.32 | 90.99 | 24.32 | 22.49 |
| Chico | 5 | 128.24 | 43.24 | 23.24 | 21.44 |
| South | 6 | 121.96 | 92.12 | 30.46 | 28.12 |

The Chico offset is computed but not applied to any well in the 2027
network — no new RMS wells are assigned to the Chico zone, and the
sole Chico carryover (CWSCH01b) keeps its 2022 GSP MT/MO/IM unchanged.
The 4 CWSCH nested completions contribute Feb/Apr readings to the
Chico zone benchmark via distinct site_codes despite sharing a single
map coordinate for privacy.

**Zone assignment for new wells.** The offset applied to each new well
is keyed on its NETWORK assignment (`rms_mgmt_area`), not its
geographic location. The 2 wells that are RMS for the North network
but physically inside Chico (`22N01E09B001M`, `22N01E20K001M`) use the
North offsets, consistent with their role as North RMS wells.

#### How we arrived at this methodology

Three definitions of "average spring groundwater level" were tested:

- **Feb–May average** (broadest spring window — DWR semiannual
  monitoring guidance, exact months vary by publication)
- **Feb–April average** (post-recharge / pre-pumping window; excludes
  May readings that begin to reflect evapotranspiration onset)
- **Highest March, averaged across years** (per-year peak in March,
  then averaged)

All three produce headline dry-well counts within 9 wells of each
other (430–438), with per-well MTs clustering within a few feet
across variants. Staff selected the **Feb–April** definition for the
2027 RMS network on 2026-05-21. The full sensitivity comparison —
including per-zone offsets, per-well MTs, and a statistical note on
the three approaches — is in `analysis/agwl_window_comparison.md`,
with a standalone methodology memo at `analysis/methodology_mt_mo_im.md`.

#### How to read the dry-well count

§5.3's MT-sensitivity widget reports how many domestic wells in each
polygon would have their bottom above the MT line if the water table
dropped to MT everywhere in the basin. This is a **sensitivity
analysis, not a forecast.** Three reasons it overstates real impact:

1. **The subbasin manages to MO, not MT.** Water Year 2025 groundwater
   was ~68 ft above MT and ~18 ft above MO (Vina GSA Annual Report).
   MT is a hard floor that triggers undesirable-result findings, not
   an operational target.
2. **Observed dry wells through two drought events: ~35.** DWR's
   Dry Well Reporting System recorded approximately 35 dry-well reports
   in the Vina Subbasin from January 1, 2014 through December 31, 2025
   — a period that included the 2012-16 and 2020-22 droughts. The
   observed count is an order of magnitude below any
   theoretical-at-MT scenario shown in the widget.
3. **The MT scenario assumes uniform basin-wide drawdown.** Real
   drawdown is spatially uneven and rebounds between drought cycles;
   sustained groundwater at MT across the entire basin is not what
   the GSP envisions managing toward.

The right way to read §5.3's dry-well numbers is as a comparison of
methodology and elevation-correction choices, not as predictions.

#### Statistical note on averaging vs. peak-of-peak

The AGWL Mirror methodology averages QA-Good GWE measurements across
the Feb–April window. A peak-based alternative — taking the highest
March reading each year and averaging those peaks — was also tested
and not adopted, primarily because:

- **Averaging reduces variance.** The standard error of a sample mean
  shrinks as √n. The Feb–April window contributes tens to thousands of
  measurements per well; the per-year peak contributes one per year.
- **A per-year maximum is biased upward by construction.** Taking the
  max each year guarantees the result sits at or above the mean.
  Anchoring on "typical condition" rather than "best moment of best
  moment" is closer to the Vina GSA's operational framing.
- **Data-completeness matters.** Some wells (notably the 4 CWSCH
  Chico wells) have zero March readings in DWR's record but do have
  Feb/Apr readings. The Feb–April average uses them; the per-year
  peak-in-March cannot.

None of these are universal reasons to prefer averaging — peak-based
estimates have their own uses — but for setting MT/MO/IM mirrors on
behalf of a regulatory framework, the averaging approach gave staff a
more stable, more defensible anchor.

### Caveats

The Mirror methodology is a defensible interim baseline, not an adopted
SMC. Specific limitations:

- **AGWL reflects the observed Feb–April record.** Wells with short
  records or sparse spring monitoring may understate or overstate
  typical conditions; estimates from such wells should be considered
  conservative.
- **Zone offsets are descriptive statistics, not margins of safety or
  forward projections.** They do not account for drought severity,
  climate change, or pumping trajectories. They are a backward-looking
  calibration of how the GSA's 2022 MT/MO/IM relate to typical spring
  groundwater levels at the 2022 RMS wells.
- **The Mirror is NOT a request for GSA approval.** Adopted MT/MO/IM
  remain the 2022 GSP values until the GSA formally updates them in
  the 2027 GSP cycle. The Mirror exists solely to give the dashboard
  a complete set of comparison lines so every polygon's hydrograph can
  be evaluated in the same visual framework.

### Rebuilding

```bash
python3 scripts/compute_thresholds.py          # -> data/thresholds.json
python3 scripts/build_wells_js.py              # -> js/wells-data.js
python3 scripts/update_workbook_thresholds.py  # -> appends MT/MO/IM/Source columns to xlsx
```

The workbook now carries four trailing columns (W–Z) — `MT_ft`, `MO_ft`,
`IM_2027_ft`, `Threshold_Source` — populated for the 26 wells in the
2027 RMS network (matching `data/thresholds.json`), with 2022 GSP rows
shaded light blue and AGWL Mirror rows shaded warm cream. The 8 Chico
nested-completion supplementals are not RMS in 2027 and are left blank.

---

## Domestic-well sensitivity to MT (2026-05-22)

§5.2 includes a "Show domestic wells" toggle that overlays **1,253
active domestic wells** from the **`Vina_GWL_MT22_analysis_v6.xlsx`**
inventory, provided by Larry Walker Associates (LWA) in April 2026.
The wells are canvas-rendered for performance and color-coded by which
2027 mgmt area their lat/lng falls into. A build script under `scripts/`
stages the inventory and spatial-joins each well to its containing
2027 polygon.

§5.3 includes the **MT sensitivity widget**: a slider, an
elevation-correction toggle, and a sensitivity table.

**Slider** (`MT raise: 0–30 ft`). Adjusts the selected polygon's MT
upward in 1-ft increments for sensitivity exploration. The
hydrograph draws a dashed orange "MT + N" line at the raised value,
and the RMS well's popup reports dry-domestic-well counts at both
the original MT and the slider-adjusted MT.

**Sensitivity table**. Two rows:

- **Subbasin (basin-wide, n=1,253)**: cumulative dry counts across
  the entire 2027 RMS network. For each polygon, computes
  dry-at-MT, dry-at-MT+5, ..., dry-at-MT+30 using that polygon's
  RMS well's MT, and sums across polygons.
- **Selected polygon**: same calculation, just for the wells inside
  the currently-selected polygon.

The column matching the slider's current value (rounded to the
nearest 5-ft step) is highlighted in warm cream.

**Definition of "dry"**: a domestic well is "dry" at a given MT
when its well-bottom elevation (AMSL) sits above MT. Geometrically,
if regional water levels fell to MT, the water table would be below
the well's bottom and no water would be pumpable. Raising MT to
preserve more groundwater therefore *reduces* the dry-well count,
which is why all sensitivity counts in the table decrease as you
move from MT to MT+30.

**Elevation correction toggle** (`Adjust threshold for each well's
elevation`). When on, the dry calculation uses an
*effective_MT* that is shifted upward for domestic wells located
*higher than* their polygon's RMS well:

```
gse_delta     = max(0, domestic_gse − rms_gse)   # one-sided
effective_MT  = polygon_MT + slider_raise + gse_delta
dry           = (well_bottom_amsl > effective_MT)
```

This is a "one-sided" foothill correction: a domestic well in the
foothills above its valley RMS well needs a higher local GWE to be
wet, so its effective MT is the basin MT plus the elevation
difference. Wells *lower* than their RMS well (more common) are not
adjusted.

**RMS well popup additions**. Clicking an RMS well marker shows two
extra lines (both independent of the sensitivity slider — the slider
only drives the hydrograph and sensitivity table):

- **Dry domestic wells at MT (`N` ft)**: count of dry domestic wells
  inside this RMS well's polygon at the polygon's original MT, with
  no elevation adjustment. Reference baseline.
- **Dry at adjusted MT, based on well elevation**: count where each
  domestic well's effective MT is shifted upward by
  `max(0, domestic_gse − rms_gse)` if and only if the §5.3 "Adjust
  threshold for each well's elevation" toggle is on. When the toggle
  is off this line matches the line above (no per-well adjustment
  applied); when on it shows the one-sided foothill correction.

Popup content is recomputed fresh each time a popup opens, so the
adjusted-MT line always reflects the current elev-correction toggle
state.

---

## Data sources

| Layer | Source | Endpoint |
|-------|--------|----------|
| RMS network membership + well metadata (79 wells in the broader monitoring set, 26 flagged as 2027 RMS) | `BC Network 2026 v8.xlsx` | local file (Butte County WRC) |
| Domestic wells overlay (1,253 active wells used in the §5.2 overlay and §5.3 sensitivity widget) | `Vina_GWL_MT22_analysis_v6.xlsx` | local file (provided by Larry Walker Associates, April 2026) |
| DWR site_code resolution | DWR CKAN Stations resource | https://data.cnra.ca.gov/dataset/periodic-groundwater-level-measurements (resource `af157380-...`) |
| Periodic GWL measurements | DWR CKAN Measurements resource | same dataset, resource `bfa9f262-24a1-45bd-8dc8-138bc8107266` (filtered to network sites via `datastore_search` API) |
| Vina Subbasin boundary | DWR ArcGIS REST i08 B118 | `Basin_Subbasin_Number='5-021.57'` |
| MT / MO / IM-2027 thresholds | 2022 Vina GSP (for the 9 carryover wells) + AGWL Mirror methodology applied to DWR Feb–April periodic measurements (for the 17 new wells) | see "MT / MO / IM-2027 threshold methodology" above |

DWR refresh stamp is shown in the page header — it comes from
`MEASUREMENTS_META.fetched_at` in `js/measurements-data.js`. To refresh, just
re-run `scripts/fetch_dwr_measurements.py`.
