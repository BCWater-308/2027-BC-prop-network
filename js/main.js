// Vina Subbasin 2027 RMS Network Dashboard — UI logic.
// Loads WELLS, RMS_POLYGONS_SINGLE, RMS_POLYGONS_THREE_ZONE,
// MEASUREMENTS, VINA_BOUNDARY as globals. The active polygon set is
// chosen by the §5.2 "Polygon method" picker; `RMS_POLYGONS` is a
// dashboard-local alias that gets swapped when the picker changes.

(function () {
  "use strict";

  /* -------------- polygon-method state --------------------------------- */
  // Either "single" (one Voronoi diagram clipped to the Vina Subbasin) or
  // "three_zone" (three independent tessellations, one per management area).
  let polygonMethod = "three_zone";
  let RMS_POLYGONS = (typeof RMS_POLYGONS_THREE_ZONE !== "undefined")
    ? RMS_POLYGONS_THREE_ZONE
    : (typeof RMS_POLYGONS_SINGLE !== "undefined" ? RMS_POLYGONS_SINGLE : []);

  /* -------------- palette ------------------------------------------------ */
  const MA_COLORS = {
    "01-Vina-North": "#1f4ee0",
    "02-Vina-Chico": "#e07b1f",
    "03-Vina-South": "#2ca02c",
    "Other": "#888888",
  };
  const TRACE_COLORS = [
    "#1f77b4", "#ff7f0e", "#2ca02c", "#d62728", "#9467bd",
    "#8c564b", "#e377c2", "#7f7f7f", "#bcbd22", "#17becf",
    "#3b5fd9", "#c25a00", "#1ea54a", "#a32424", "#7a4ba1",
  ];
  const DROUGHT_PERIODS = [
    ["1991-01-01", "1993-12-31"],
    ["2012-01-01", "2015-12-31"],
    ["2020-01-01", "2022-12-31"],
  ];

  /* -------------- helpers ------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  function fmt(v, d = 2) {
    if (v === null || v === undefined || v === "" || Number.isNaN(v)) return "—";
    if (typeof v === "number") return v.toFixed(d);
    return String(v);
  }
  function fmtDate(s) { return s || "—"; }

  // Build a Leaflet polygon from rings [[lat,lng], ...]
  function polyFromRings(rings, style) { return L.polygon(rings, style); }

  // Point-in-polygon: which polygon does a (lat,lng) fall into?
  function pointInRings(latlng, rings) {
    // Leaflet polygons accept rings in any winding; use a simple PIP on outer ring.
    const [lat, lng] = latlng;
    const ring = rings[0];
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [yi, xi] = ring[i], [yj, xj] = ring[j];
      const intersect = (yi > lat) !== (yj > lat)
        && lng < (xj - xi) * (lat - yi) / (yj - yi + 1e-12) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function pointInPolygon(latlng, poly) {
    // Multi-ring support: outer + holes (we don't have holes, but keep correct)
    if (!pointInRings(latlng, poly.rings)) return false;
    // Subtract holes (rings beyond the first if they're contained)
    for (let i = 1; i < poly.rings.length; i++) {
      if (pointInRings(latlng, [poly.rings[i]])) return false;
    }
    return true;
  }

  function wellsInsidePolygon(poly) {
    return WELLS.filter((w) => {
      if (w.latitude == null || w.longitude == null) return false;
      return pointInPolygon([w.latitude, w.longitude], poly);
    });
  }

  // Resolve "the wells this polygon represents" depending on whether it's a
  // Voronoi cell (per-well) or an aggregate polygon (e.g. dissolved Chico
  // mgmt area in the 2026-05-19 network revision, which is associated with
  // 10 specific well completions across two nested sites instead of one
  // geographic seed).
  function polygonWells(poly) {
    if (poly.is_aggregate && Array.isArray(poly.rms_well_swns)) {
      return poly.rms_well_swns
        .map((swn) => WELLS.find((w) => w.swn === swn))
        .filter(Boolean);
    }
    const inside = wellsInsidePolygon(poly);
    if (poly.rms_well_swn && !inside.find((w) => w.swn === poly.rms_well_swn)) {
      const seed = WELLS.find((w) => w.swn === poly.rms_well_swn);
      if (seed) inside.unshift(seed);
    }
    return inside;
  }

  // Pearson correlation coefficient
  function pearson(xs, ys) {
    const n = xs.length;
    if (n < 2) return null;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let num = 0, dx2 = 0, dy2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      num += dx * dy;
      dx2 += dx * dx;
      dy2 += dy * dy;
    }
    const denom = Math.sqrt(dx2 * dy2);
    if (denom === 0) return null;
    return num / denom;
  }

  /* -------------- KPI row ----------------------------------------------- */
  function renderKPIs() {
    const n = WELLS.length;
    // Count RMS "sites" (distinct lat/lng) not raw is_2027_gwl_rms entries,
    // so co-located CWSCH completions collapse to one site on the map.
    const rmsSites = new Set(
      WELLS.filter((w) => w.is_2027_gwl_rms && w.latitude != null && w.longitude != null)
        .map((w) => `${(+w.latitude).toFixed(5)}|${(+w.longitude).toFixed(5)}`)
    );
    $("#kpi-wells").textContent = n;
    $("#kpi-rms-2027").textContent = rmsSites.size;
    $("#kpi-poly").textContent = RMS_POLYGONS.length;

    // Data freshness from MEASUREMENTS metadata if available
    const meta = (typeof MEASUREMENTS_META !== "undefined") ? MEASUREMENTS_META : null;
    if (meta && meta.fetched_at) {
      $("#data-freshness").textContent = `DWR refresh: ${meta.fetched_at.slice(0, 10)} · ${meta.n_records.toLocaleString()} records across ${meta.n_wells} wells`;
    }
  }

  /* -------------- nested-well grouping (by lat/lon) --------------------- */
  // siteGroups: "lat|lng" -> [well, ...]  ;  wellSiteKey: wellName -> "lat|lng"
  const siteGroups = {};
  const wellSiteKey = {};
  WELLS.forEach((w) => {
    if (w.latitude == null || w.longitude == null) return;
    const k = `${(+w.latitude).toFixed(5)}|${(+w.longitude).toFixed(5)}`;
    (siteGroups[k] = siteGroups[k] || []).push(w);
    wellSiteKey[w.swn] = k;
  });
  function nestedCount(w) {
    const k = wellSiteKey[w.swn];
    return (siteGroups[k] || []).length;
  }

  /* -------------- measurement helpers ----------------------------------- */
  function getMeas(w) {
    if (!w.site_code) return [];
    return MEASUREMENTS[w.site_code] || [];
  }
  function isContinuous(w) {
    return (w.monitor_freq || "").toLowerCase().includes("hour")
      || (w.monitor_freq || "").toLowerCase().includes("daily")
      || (w.monitor_freq || "").toLowerCase().includes("continuous");
  }
  function measurementSummary(records) {
    const good = records.filter((r) => r.qa && r.qa.toLowerCase().includes("good") && r.gwe !== null);
    const questionable = records.filter((r) => r.qa && r.qa.toLowerCase().includes("question"));
    const missing = records.filter((r) => r.qa && r.qa.toLowerCase().includes("missing"));
    const lastGood = good.length ? good[good.length - 1] : null;
    return {
      total: records.length,
      good: good.length,
      questionable: questionable.length,
      missing: missing.length,
      firstYear: good.length ? good[0].d.slice(0, 4) : null,
      lastYear: good.length ? good[good.length - 1].d.slice(0, 4) : null,
      lastGoodDate: lastGood ? lastGood.d : null,
      lastGoodGwe: lastGood ? lastGood.gwe : null,
    };
  }
  function currentWSE(w) {
    // Latest non-null GWE regardless of QA flag (popup helper).
    // Returns both the groundwater elevation (msl) and depth-to-groundwater
    // (below GSE) when available. Falls back to computing dtw from gwe + gse
    // for the few records where only gwe is present.
    const ms = getMeas(w);
    const gse = w.gse != null ? +w.gse : null;
    for (let i = ms.length - 1; i >= 0; i--) {
      if (ms[i].gwe != null) {
        let dtw = ms[i].dtw;
        if (dtw == null && gse != null) dtw = gse - ms[i].gwe;
        return { gwe: ms[i].gwe, dtw, date: ms[i].d, qa: ms[i].qa };
      }
    }
    return null;
  }

  /* -------------- 5.2 Leaflet map --------------------------------------- */
  let map, polygonLayer, basinLayer, rms2027Layer, suppLayer, domesticLayer;

  /* -------------- MT sensitivity (domestic wells) ---------------------- */
  // Slider value (0–30 ft, the amount by which MT is hypothetically raised
  // for sensitivity analysis). Updated by the §5.3 slider; drives the
  // sensitivity widget, the hydrograph's "raised MT" line, and the RMS
  // well popup's adjusted dry count.
  let mtRaiseFt = 0;
  // When true, apply the cosmo "one-sided" elevation correction to dry
  // counts: effective_MT for a domestic well = MT + max(0, well_gse - rms_gse).
  let elevCorrectionOn = false;

  // Threshold-raise columns shown in the sensitivity table.
  const SENS_RAISES = [0, 5, 10, 15, 20, 25, 30];

  // Active domestic wells: those flagged include=1 in the cosmo bundle and
  // with a valid lat/lon, well_bottom_amsl. Cached once at startup.
  let DOMESTIC_ACTIVE = [];
  // Per-polygon dictionary: zone_label -> array of active domestic wells
  // that fall inside that polygon. Cached once at startup.
  let DOMESTIC_BY_POLYGON = {};

  // Build the active-domestic-wells caches. Called once after data load.
  function buildDomesticCaches() {
    if (typeof DOMESTIC_WELLS === "undefined") return;
    DOMESTIC_ACTIVE = DOMESTIC_WELLS.filter((w) =>
      w.include === 1 && w.lat != null && w.lon != null && w.well_bottom_amsl != null
    );
    DOMESTIC_BY_POLYGON = {};
    DOMESTIC_ACTIVE.forEach((w) => {
      const key = w.our_polygon;
      if (!key) return;
      (DOMESTIC_BY_POLYGON[key] = DOMESTIC_BY_POLYGON[key] || []).push(w);
    });
  }

  // Count dry domestic wells in `wells` (a list of domestic-well records)
  // at the given polygon MT raised by `raise_ft`. If `elev_correct` is true,
  // each well's effective MT is raised further by max(0, well_gse - rms_gse).
  // Returns { dry, total }.
  function countDryDomestic(wells, mt_ft, rms_gse, raise_ft, elev_correct) {
    if (mt_ft == null) return { dry: 0, total: 0 };
    let dry = 0;
    const baseMT = mt_ft + raise_ft;
    for (const w of wells) {
      const gseDelta = (elev_correct && rms_gse != null && w.local_gse != null)
        ? Math.max(0, w.local_gse - rms_gse) : 0;
      const effectiveMT = baseMT + gseDelta;
      if (w.well_bottom_amsl > effectiveMT) dry++;
    }
    return { dry, total: wells.length };
  }

  // Basin-wide dry counts at the given raise. Uses each well's HOME polygon's
  // MT. For elev-correction, uses each polygon's seed RMS well's GSE.
  function basinDryCount(raise_ft, elev_correct) {
    let dry = 0, total = 0;
    if (typeof RMS_POLYGONS === "undefined") return { dry, total };
    RMS_POLYGONS.forEach((poly) => {
      const pgnWells = DOMESTIC_BY_POLYGON[poly.zone_label] || [];
      if (pgnWells.length === 0) return;
      const mt_ft = polygonMT(poly);
      const rms_gse = polygonRmsGSE(poly);
      const c = countDryDomestic(pgnWells, mt_ft, rms_gse, raise_ft, elev_correct);
      dry += c.dry;
      total += c.total;
    });
    return { dry, total };
  }

  // For aggregate polygons (Chico), use the active primary well's MT/GSE
  // (currentSelection.primaryWell when a specific CWSCH entry is selected,
  // otherwise fall back to the first primary in rms_primary_swns).
  function polygonMT(poly) {
    const primarySwn = (poly.is_aggregate && currentSelection?.primaryWell)
      ? currentSelection.primaryWell
      : (poly.is_aggregate ? (poly.rms_primary_swns || [])[0] : poly.rms_well_swn);
    if (!primarySwn) return null;
    const w = WELLS.find((x) => x.swn === primarySwn);
    return w ? w.mt_ft : null;
  }

  function polygonRmsGSE(poly) {
    const primarySwn = (poly.is_aggregate && currentSelection?.primaryWell)
      ? currentSelection.primaryWell
      : (poly.is_aggregate ? (poly.rms_primary_swns || [])[0] : poly.rms_well_swn);
    if (!primarySwn) return null;
    const w = WELLS.find((x) => x.swn === primarySwn);
    return w ? (w.gse != null ? +w.gse : null) : null;
  }
  let basemapLayer = null;
  let polygonRefs = {};   // zone_label -> { leafletPoly, dataPoly }
  let selectedPoly = null;
  let shadingOn = true;

  const BASEMAPS = {
    "carto": {
      url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
      options: {
        maxZoom: 19, subdomains: "abcd",
        attribution: '&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; OSM',
      },
    },
    "osm": {
      url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
      options: { maxZoom: 19, attribution: "© OpenStreetMap" },
    },
    "esri-sat": {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: "Tiles © Esri" },
    },
    "esri-topo": {
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}",
      options: { maxZoom: 19, attribution: "Tiles © Esri" },
    },
  };

  function setBasemap(key) {
    if (!map) return;
    if (basemapLayer) map.removeLayer(basemapLayer);
    const b = BASEMAPS[key] || BASEMAPS.carto;
    basemapLayer = L.tileLayer(b.url, b.options).addTo(map);
    basemapLayer.bringToBack();
  }

  // Look up "is this well's location inside the Chico mgmt area polygon"
  // from the three-zone polygons data (every N-cell polygon carries this
  // flag, derived during the build at scripts/build_polygons_three_zone.py).
  function isWellPhysicallyInChico(swn) {
    if (typeof RMS_POLYGONS_THREE_ZONE === "undefined") return false;
    const p = RMS_POLYGONS_THREE_ZONE.find((x) => x.rms_well_swn === swn);
    return !!(p && p.well_in_chico_mgmt_area);
  }

  function buildWellPopup(w) {
    const lat = w.latitude, lng = w.longitude;
    const wse = currentWSE(w);
    let wseLine;
    if (wse) {
      const dateSuffix = `<span style="color:#888;">(${wse.date}${wse.qa ? `, ${wse.qa}` : ""})</span>`;
      const dtwTxt = wse.dtw != null
        ? `${wse.dtw.toFixed(2)} ft below GSE ${dateSuffix}`
        : `<span style="color:#888;">—</span>`;
      wseLine =
        `<div><b>Current WSE:</b> ${wse.gwe.toFixed(2)} ft msl ${dateSuffix}</div>` +
        `<div><b>Depth to GW:</b> ${dtwTxt}</div>`;
    } else {
      wseLine = `<div><b>Current WSE / DTW:</b> <span style="color:#888;">no DWR record</span></div>`;
    }
    // Record span — first→last "Good" year, plus the count of good records
    const stats = measurementSummary(getMeas(w));
    const recordLine = stats.firstYear
      ? `<div><b>Record:</b> ${stats.firstYear}–${stats.lastYear} <span style="color:#888;">(${stats.good.toLocaleString()} good)</span></div>`
      : `<div><b>Record:</b> <span style="color:#888;">no DWR record</span></div>`;
    const nC = nestedCount(w);
    const nestedLine = nC > 1
      ? `<div><b>Nested completions:</b> <span style="color:#c2410c;font-weight:600;">×${nC}</span> wells share this location</div>`
      : "";
    const bcReason = (w.butte_co_reasoning || "").trim();
    const bcLine = bcReason
      ? `<div style="margin-top:6px; padding-top:6px; border-top:1px solid #eee;"><b>Butte County reasoning:</b><br>${bcReason}</div>`
      : "";
    // For the 3 N RMS wells whose physical location is inside the Chico
    // mgmt area (22N01E09B001M, 22N01E20K001M, 23N01E33A001M), surface
    // that fact so reviewers understand why the well marker sits inside
    // the Chico polygon while the well's Thiessen cell is drawn in N.
    const chicoNote = (w.is_2027_gwl_rms && isWellPhysicallyInChico(w.swn))
      ? `<div style="margin-top:4px;color:#c25a00;font-size:11.5px;"><b>Note:</b> physical location inside the Chico mgmt area; RMS for the North network. The Thiessen cell sits north of this well (Chico territory is clipped away).</div>`
      : "";
    // For 21N02E26E006M (and any future wells using the same convention)
    // the MT/MO/IM are inherited from a nested sibling that was 2022 RMS.
    const inheritNote = w.carryover_from
      ? `<div style="margin-top:4px;color:#c25a00;font-size:11.5px;"><b>Note:</b> MT/MO/IM inherited from <code>${w.carryover_from}</code>, the 2022 GSP RMS at this same lat/lng (different completion depth).</div>`
      : "";
    // Domestic-well dry counts at this RMS well's polygon. Two lines,
    // both INDEPENDENT of the sensitivity slider (the slider drives the
    // hydrograph + sensitivity table, not the popup):
    //   1. Dry domestic wells at MT — count at the polygon's original MT
    //      with no elevation adjustment. Always shown.
    //   2. Dry at adjusted MT, based on well elevation — count when each
    //      well's effective MT is shifted upward by max(0, well_gse - rms_gse)
    //      ONLY when the "Adjust threshold for each well's elevation"
    //      toggle is on. When the toggle is off, line 2 equals line 1
    //      (no per-well adjustment applied) — same number, kept visible so
    //      the toggle's effect is obvious when it's flipped.
    let domLine = "";
    if (w.is_2027_gwl_rms && typeof DOMESTIC_BY_POLYGON !== "undefined") {
      // Find the polygon for which this well is the (or a) RMS seed.
      const poly = (typeof RMS_POLYGONS !== "undefined" ? RMS_POLYGONS : []).find(
        (p) => p.rms_well_swn === w.swn
          || (p.is_aggregate && (p.rms_primary_swns || []).includes(w.swn))
      );
      if (poly) {
        const polyWells = DOMESTIC_BY_POLYGON[poly.zone_label] || [];
        if (polyWells.length > 0) {
          const rmsGse = w.gse != null ? +w.gse : null;
          // Line 1: original MT, no elevation correction, no slider raise.
          const cAt = countDryDomestic(polyWells, w.mt_ft, rmsGse, 0, false);
          // Line 2: elevation correction only when toggle is on; still no slider raise.
          const cAdj = countDryDomestic(polyWells, w.mt_ft, rmsGse, 0, elevCorrectionOn);
          const pct = (c) => c.total > 0 ? (100 * c.dry / c.total).toFixed(0) : "0";
          domLine =
            `<div style="margin-top:6px;padding-top:6px;border-top:1px solid #eee;">` +
            `<div><b>Dry domestic wells at MT (${w.mt_ft} ft):</b> ${cAt.dry} of ${cAt.total} (${pct(cAt)}%)</div>` +
            `<div><b>Dry at adjusted MT, based on well elevation:</b> ${cAdj.dry} of ${cAdj.total} (${pct(cAdj)}%)</div>` +
            (elevCorrectionOn
              ? `<div style="color:#888;font-size:11px;">(elevation correction <b>on</b>)</div>`
              : `<div style="color:#888;font-size:11px;">(elevation correction off — toggle on in §5.3 to apply)</div>`) +
            `</div>`;
        }
      }
    }
    return `
      <div style="font-size:12.5px;line-height:1.45;max-width:300px;">
        <div style="font-weight:600;font-size:13px;margin-bottom:4px;">${w.well_name}</div>
        <div><b>Mgmt area:</b> ${w.mgmt_area_full || "—"}</div>
        <div><b>Role:</b> ${w.is_2027_gwl_rms ? "2027 Proposed RMS" : "Supplemental"}${w.is_2022_gwl_rms ? " · was 2022 RMS" : ""}</div>
        ${chicoNote}
        ${inheritNote}
        ${wseLine}
        ${recordLine}
        ${nestedLine}
        ${domLine}
        <div><b>Well use:</b> ${w.well_use || "—"}</div>
        <div><b>Depth:</b> ${fmt(w.well_depth, 0)} ft</div>
        <div><b>Screen:</b> ${w.screen_intervals || "—"}</div>
        <div><b>Monitor freq:</b> ${w.monitor_freq || "—"}</div>
        <div><b>GSE / RPE:</b> ${fmt(w.gse)} / ${fmt(w.rpe)} ft</div>
        <div><b>Site code:</b> <code>${w.site_code || "—"}</code></div>
        <div><b>Lat / Lon:</b> ${fmt(lat, 5)}, ${fmt(lng, 5)}</div>
        ${bcLine}
      </div>`;
  }

  // Invisible halo radius added around each visible marker, so near-miss
  // clicks still open the popup instead of falling through to the polygon
  // underneath. ~10px gives a comfortable target without overlapping
  // neighboring wells in the basin.
  const HIT_PAD_PX = 10;

  function makeWellMarker(w) {
    const lat = w.latitude, lng = w.longitude;
    if (lat == null || lng == null) return null;
    const nC = nestedCount(w);
    const baseStyle = w.is_2027_gwl_rms
      ? { radius: 9, fillColor: "#1e40af", color: "#fff", weight: 2, opacity: 1, fillOpacity: 0.95 }
      : { radius: 5, fillColor: "#888", color: "#fff", weight: 1, opacity: 1, fillOpacity: 0.85 };
    // Visually mark nested sites with a slightly larger radius + orange ring
    const style = nC > 1
      ? { ...baseStyle, radius: baseStyle.radius + 1, color: "#c2410c", weight: 2 }
      : baseStyle;
    const visible = L.circleMarker([lat, lng], { ...style, pane: "wellsPane" });
    const hit = L.circleMarker([lat, lng], {
      radius: style.radius + HIT_PAD_PX,
      opacity: 0, fillOpacity: 0, weight: 0,
      interactive: true, bubblingMouseEvents: false,
      pane: "wellsPane",
    });
    // Use function content so the popup re-computes the domestic-well dry
    // counts (which depend on the slider + elev-correction toggle) every
    // time the popup is opened. Leaflet 1.x calls the function with the
    // source layer each time the popup opens.
    visible.bindPopup(() => buildWellPopup(w), { maxWidth: 340 });
    hit.on("click", () => visible.openPopup());
    // 2022 RMS wells get a small white dot in the middle so reviewers can
    // tell at a glance which wells were already in the prior network.
    const layers = [hit, visible];
    if (w.is_2022_gwl_rms) {
      const dot = L.circleMarker([lat, lng], {
        radius: Math.max(2, Math.round(style.radius * 0.35)),
        fillColor: "#ffffff", fillOpacity: 1,
        color: "#ffffff", weight: 0, opacity: 1,
        interactive: false, pane: "wellsPane",
      });
      layers.push(dot);
    }
    const group = L.featureGroup(layers);
    group.well = w;
    return group;
  }

  /* For nested sites — one marker that opens a popup listing all completions */
  function makeNestedMarker(wells) {
    if (wells.length === 1) return makeWellMarker(wells[0]);
    const lat = wells[0].latitude, lng = wells[0].longitude;
    // Mark with priority = 2027 RMS if any, else supplemental
    const hasRms = wells.some((w) => w.is_2027_gwl_rms);
    const baseStyle = hasRms
      ? { radius: 11, fillColor: "#1e40af", color: "#c2410c", weight: 2.5, opacity: 1, fillOpacity: 0.95 }
      : { radius: 7,  fillColor: "#888",    color: "#c2410c", weight: 2,   opacity: 1, fillOpacity: 0.9 };
    const visible = L.circleMarker([lat, lng], { ...baseStyle, pane: "wellsPane" });
    const hit = L.circleMarker([lat, lng], {
      radius: baseStyle.radius + HIT_PAD_PX,
      opacity: 0, fillOpacity: 0, weight: 0,
      interactive: true, bubblingMouseEvents: false,
      pane: "wellsPane",
    });
    // Tab through each completion in the popup
    const tabs = wells.map((w, i) => `<button data-tab="${i}" class="nested-tab" style="margin-right:4px;padding:2px 8px;font-size:11px;cursor:pointer;border:1px solid #c7d6f5;background:${i===0?'#1e40af':'#f0f5ff'};color:${i===0?'#fff':'#1e40af'};border-radius:3px;">${w.well_name}</button>`).join("");
    const tabsHtml = `<div style="margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid #eee;"><b>Nested site (×${wells.length}):</b><br><div style="margin-top:6px;">${tabs}</div></div>`;
    const popupEl = document.createElement("div");
    popupEl.style.fontSize = "12.5px";
    popupEl.style.maxWidth = "320px";
    function renderTab(i) {
      popupEl.innerHTML = tabsHtml + buildWellPopup(wells[i]);
      popupEl.querySelectorAll(".nested-tab").forEach((btn, j) => {
        btn.style.background = j === i ? "#1e40af" : "#f0f5ff";
        btn.style.color = j === i ? "#fff" : "#1e40af";
        btn.addEventListener("click", (e) => { e.stopPropagation(); renderTab(j); });
      });
    }
    renderTab(0);
    visible.bindPopup(popupEl, { maxWidth: 340 });
    hit.on("click", () => visible.openPopup());
    // 2022 RMS marker — show the white dot if ANY well at this site was
    // 2022 RMS (e.g. nested completions in the CWSCH and 22N01E28J sites
    // where some primaries are 2022 RMS but not all completions).
    const layers = [hit, visible];
    if (wells.some((w) => w.is_2022_gwl_rms)) {
      const dot = L.circleMarker([lat, lng], {
        radius: Math.max(2, Math.round(baseStyle.radius * 0.35)),
        fillColor: "#ffffff", fillOpacity: 1,
        color: "#ffffff", weight: 0, opacity: 1,
        interactive: false, pane: "wellsPane",
      });
      layers.push(dot);
    }
    const group = L.featureGroup(layers);
    group.wells = wells;
    return group;
  }

  function styleForPolygon(poly, selected) {
    const c = MA_COLORS[poly.mgmt_area_full] || "#888";
    // Critical: ALWAYS keep fill present (even when "shading off") so the
    // polygon's interior remains clickable. Use a near-transparent fill
    // when shading is off so visually only the outline shows.
    return {
      color: c,                                      // outline color
      weight: selected ? 3 : 1.5,                    // selection thickens outline only
      fillColor: c,
      fill: true,
      fillOpacity: shadingOn ? (selected ? 0.40 : 0.18) : 0.001,
    };
  }

  // (Re)build the Leaflet polygon layer from whichever set is active.
  // Clears `polygonRefs` and `polygonLayer` first so this can be called
  // both at initial render and when the method picker flips.
  function buildPolygonLayer() {
    polygonRefs = {};
    polygonLayer.clearLayers();
    RMS_POLYGONS.forEach((poly) => {
      const lp = L.polygon(poly.rings, { ...styleForPolygon(poly, false), pane: "polygonsPane" });
      lp.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        selectPolygon(poly.zone_label);
      });
      lp.on("mouseover", () => {
        if (selectedPoly !== poly.zone_label) lp.setStyle({ fillOpacity: shadingOn ? 0.30 : 0.10 });
      });
      lp.on("mouseout", () => {
        if (selectedPoly !== poly.zone_label) lp.setStyle(styleForPolygon(poly, false));
      });
      polygonRefs[poly.zone_label] = { lp, poly };
      polygonLayer.addLayer(lp);
    });
  }

  // Swap the active polygon set (single ↔ three-zone). Rebuilds the map
  // polygon layer, re-populates the §5.3 picker, refreshes the KPI count
  // (single = 27 cells, three-zone = 26), and re-selects the
  // previously-selected SWN if it still exists in the new set.
  function setPolygonMethod(method) {
    if (method !== "single" && method !== "three_zone") return;
    if (typeof RMS_POLYGONS_SINGLE === "undefined"
        || typeof RMS_POLYGONS_THREE_ZONE === "undefined") return;
    polygonMethod = method;
    RMS_POLYGONS = method === "three_zone" ? RMS_POLYGONS_THREE_ZONE : RMS_POLYGONS_SINGLE;
    const keep = selectedPoly;  // always the bare zone_label (no ":" suffix)
    buildPolygonLayer();
    populatePolygonPicker();
    $("#kpi-poly").textContent = RMS_POLYGONS.length;
    if (keep && RMS_POLYGONS.find((p) => p.zone_label === keep)) {
      selectPolygon(keep);
    } else if (RMS_POLYGONS.length) {
      selectPolygon(RMS_POLYGONS[0].zone_label);
    }
  }

  function renderMap() {
    map = L.map("map", { preferCanvas: false, zoomControl: true }).setView([39.74, -121.86], 11);
    setBasemap("carto");

    // Dedicated panes so well markers always sit above Thiessen polygons
    // regardless of layer add/remove order or setStyle calls. Stacking is
    // pinned via CSS z-index, not SVG DOM order — this is what makes the
    // hit halos reliable when the user toggles polygon methods.
    map.createPane("polygonsPane");
    map.getPane("polygonsPane").style.zIndex = 400;
    map.createPane("wellsPane");
    map.getPane("wellsPane").style.zIndex = 450;

    // Vina Subbasin boundary (always shown)
    basinLayer = L.geoJSON(VINA_BOUNDARY, {
      style: { color: "#222", weight: 2.2, fill: false, dashArray: "4,4", opacity: 0.85 },
      interactive: false,
    }).addTo(map);

    // Thiessen polygons (always interactive even when shading is off so clicks still work)
    polygonLayer = L.layerGroup();
    buildPolygonLayer();
    polygonLayer.addTo(map);

    // Marker layers (2 tiers only: 2027 RMS + supplemental); nested completions
    // collapse into a single marker per lat/lon site with a tabbed popup.
    rms2027Layer = L.layerGroup();
    suppLayer = L.layerGroup();
    const seenSites = new Set();
    WELLS.forEach((w) => {
      const sk = wellSiteKey[w.swn];
      if (!sk || seenSites.has(sk)) return;
      seenSites.add(sk);
      const group = siteGroups[sk];
      const m = makeNestedMarker(group);
      if (!m) return;
      // Place in 2027 layer if any well in the group is RMS, else supplemental
      const hasRms = group.some((g) => g.is_2027_gwl_rms);
      if (hasRms) rms2027Layer.addLayer(m); else suppLayer.addLayer(m);
    });
    rms2027Layer.addTo(map);
    suppLayer.addTo(map);

    // Domestic-wells overlay (lazily built — 1,253 active markers; uses a
    // canvas renderer for perf since SVG with 1k+ markers stutters on pan).
    // Each well is a small gray dot. The marker list is bundled in
    // js/domestic-wells-data.js as DOMESTIC_WELLS (include=1 only filters
    // applied at render time). Default: hidden.
    domesticLayer = buildDomesticLayer();
    // Not added to map by default; toggled via #tog-domestic below.

    // Fit to polygons
    const allBounds = L.featureGroup(Object.values(polygonRefs).map((r) => r.lp)).getBounds();
    map.fitBounds(allBounds, { padding: [20, 20] });

    // Toggles
    $("#tog-polys").addEventListener("change", (e) => {
      if (e.target.checked) polygonLayer.addTo(map); else map.removeLayer(polygonLayer);
    });
    $("#tog-shading").addEventListener("change", (e) => {
      shadingOn = e.target.checked;
      Object.entries(polygonRefs).forEach(([k, r]) => {
        r.lp.setStyle(styleForPolygon(r.poly, k === selectedPoly));
      });
    });
    $("#tog-rms-2027").addEventListener("change", (e) => {
      if (e.target.checked) rms2027Layer.addTo(map); else map.removeLayer(rms2027Layer);
    });
    $("#tog-supp").addEventListener("change", (e) => {
      if (e.target.checked) suppLayer.addTo(map); else map.removeLayer(suppLayer);
    });
    $("#tog-domestic").addEventListener("change", (e) => {
      if (e.target.checked) domesticLayer.addTo(map); else map.removeLayer(domesticLayer);
    });
    $("#picker-basemap").addEventListener("change", (e) => setBasemap(e.target.value));
    $("#picker-poly-method").addEventListener("change", (e) => setPolygonMethod(e.target.value));
  }

  // Build the domestic-wells overlay layer. Canvas-rendered for performance
  // (1,253 active wells). Color-coded by their assigned 2027 mgmt area so
  // they're visually grouped without needing a separate marker per area.
  function buildDomesticLayer() {
    if (typeof DOMESTIC_WELLS === "undefined") return L.layerGroup();
    const canvas = L.canvas({ padding: 0.5 });
    const fillByMA = {
      "North": "#1f4ee0",
      "Chico": "#e07b1f",
      "South": "#2ca02c",
    };
    const layer = L.layerGroup();
    DOMESTIC_WELLS.forEach((w) => {
      if (w.include !== 1) return;
      if (w.lat == null || w.lon == null) return;
      const fill = fillByMA[w.our_mgmt_area] || "#9ca3af";
      L.circleMarker([w.lat, w.lon], {
        radius: 2.5,
        fillColor: fill,
        fillOpacity: 0.55,
        color: fill,
        weight: 0,
        opacity: 0,
        renderer: canvas,
        interactive: false,  // perf: skip event wiring (no click popups)
      }).addTo(layer);
    });
    return layer;
  }

  /* -------------- 5.3 picker & hydrograph ------------------------------- */
  function populatePolygonPicker() {
    const sel = $("#picker-poly");
    sel.innerHTML = "";
    // sort by mgmt area then SWN
    const sorted = RMS_POLYGONS.slice().sort((a, b) => {
      if (a.mgmt_area_full !== b.mgmt_area_full) return a.mgmt_area_full.localeCompare(b.mgmt_area_full);
      return a.zone_label.localeCompare(b.zone_label);
    });
    sorted.forEach((p) => {
      const maShort = p.mgmt_area_full.replace(/^0\d-/, "");
      // Aggregate polygons with multiple RMS primaries (e.g. Chico with 4
      // CWSCH wells) get one picker entry per primary so each well's MT/MO/IM
      // can be viewed independently while keeping all 9 context traces plotted.
      if (p.is_aggregate && Array.isArray(p.rms_primary_swns) && p.rms_primary_swns.length > 1) {
        p.rms_primary_swns.forEach((swn) => {
          const opt = document.createElement("option");
          opt.value = `${p.zone_label}:${swn}`;
          opt.textContent = `${maShort}  ·  ${swn} (RMS)`;
          sel.appendChild(opt);
        });
      } else {
        const opt = document.createElement("option");
        opt.value = p.zone_label;
        opt.textContent = p.is_aggregate && p.rms_label
          ? p.rms_label
          : `${maShort}  ·  ${p.zone_label}`;
        sel.appendChild(opt);
      }
    });
    sel.addEventListener("change", () => selectPolygon(sel.value));
  }

  // Current selection state for §5.3 table sorting / toggling
  let currentSelection = null;

  function selectPolygon(zoneLabel) {
    // zoneLabel may be "zone_label:primaryWell" for multi-primary aggregates.
    let polyLabel = zoneLabel, primaryWell = null;
    if (zoneLabel.includes(":")) {
      const idx = zoneLabel.indexOf(":");
      polyLabel = zoneLabel.slice(0, idx);
      primaryWell = zoneLabel.slice(idx + 1);
    }
    selectedPoly = polyLabel;
    Object.entries(polygonRefs).forEach(([k, r]) => {
      r.lp.setStyle(styleForPolygon(r.poly, k === polyLabel));
    });
    const poly = RMS_POLYGONS.find((p) => p.zone_label === polyLabel);
    if (!poly) return;
    // For multi-primary aggregates clicked from the map (no primaryWell
    // suffix), default to the first primary and sync the picker.
    if (poly.is_aggregate && Array.isArray(poly.rms_primary_swns)
        && poly.rms_primary_swns.length > 1 && !primaryWell) {
      primaryWell = poly.rms_primary_swns[0];
    }
    const pickerValue = primaryWell ? `${polyLabel}:${primaryWell}` : polyLabel;
    $("#picker-poly").value = pickerValue;

    // Build well list. For aggregate polygons (Chico in the 2026-05-19
    // revision), the wells are the explicit completions associated with
    // the polygon, not a geographic PIP — Chico's territory contains many
    // wells but only 10 are RMS for this network.
    const wellsInside = polygonWells(poly);
    // Color each well using TRACE_COLORS, same order as hydrograph traces
    const wellsWithColor = wellsInside.map((w, i) => ({
      well: w,
      color: TRACE_COLORS[i % TRACE_COLORS.length],
    }));

    // Polygon header — when a specific primary is active (e.g. CWSCH02 in
    // the Chico aggregate), show that well in the title and SMC line.
    const rmsList = primaryWell
      || wellsInside.filter((w) => w.is_2027_gwl_rms).map((w) => w.swn).join(", ")
      || poly.rms_well_swn
      || (poly.rms_well_swns || []).join(", ");
    const headerTitle = primaryWell
      ? `${poly.mgmt_area_full.replace(/^0\d-/, "")}  ·  ${primaryWell} — ${poly.mgmt_area_full} Management Area`
      : (poly.is_aggregate && poly.rms_label
        ? `${poly.rms_label} — ${poly.mgmt_area_full} Management Area`
        : `${poly.zone_label} — ${poly.mgmt_area_full} Management Area`);
    $("#poly-header").style.display = "block";
    $("#poly-header-title").textContent = headerTitle;
    $("#poly-header-meta").textContent = `${wellsInside.length} well${wellsInside.length === 1 ? "" : "s"} in zone · ${poly.area_acres.toLocaleString()} acres`;
    $("#poly-header-smc").innerHTML = `<strong>2027 GWL RMS well${rmsList.includes(",") ? "s" : ""}:</strong> ${rmsList}`;

    // Visibility init: all wells ON by default
    const visibility = {};
    wellsInside.forEach((w) => { visibility[w.swn] = true; });

    currentSelection = {
      poly,
      primaryWell,   // active CWSCH well for multi-primary aggregates, or null
      wellsWithColor,
      visibility,
      sortCol: "rms27",
      sortDir: "asc",
      traceIndices: {},   // §5.3 hydrograph: well.swn -> [traceIdx, ...]
      scatterTraceIndices: {}, // §5.4 scatter: well.swn -> [traceIdx, ...]
      displayMode: currentSelection?.displayMode || "gwe",  // remember mode across polygon changes
    };

    renderHydrograph(poly, wellsInside);
    renderWellDetailTable();
    populateRMSPicker(poly);
    renderSensitivityTable();
  }

  function renderHydrograph(poly, insideWells) {
    const mode = currentSelection?.displayMode || "gwe";  // "gwe" or "dtw"
    const isDtw = mode === "dtw";
    const traces = [];
    const traceIndices = {};
    let tIdx = 0;

    insideWells.forEach((w, idx) => {
      const color = currentSelection
        ? currentSelection.wellsWithColor.find((wc) => wc.well.swn === w.swn).color
        : TRACE_COLORS[idx % TRACE_COLORS.length];
      const ms = MEASUREMENTS[w.site_code];
      const visible = currentSelection ? (currentSelection.visibility[w.swn] ? true : "legendonly") : true;
      const here = [];

      if (ms && ms.length) {
        const xs = ms.map((m) => m.d);
        // For DTW mode: use the `dtw` field if present, else fall back to (gse - gwe)
        const gse = w.gse != null ? +w.gse : null;
        const ys = ms.map((m) => {
          if (!isDtw) return m.gwe;
          if (m.dtw != null) return m.dtw;
          if (m.gwe != null && gse != null) return gse - m.gwe;
          return null;
        });
        traces.push({
          x: xs, y: ys,
          type: "scatter", mode: "lines+markers",
          name: w.swn + (w.is_2027_gwl_rms ? " (RMS)" : ""),
          line: { color, width: w.is_2027_gwl_rms ? 2.2 : 1.4 },
          marker: { size: w.is_2027_gwl_rms ? 4 : 3, color },
          hovertemplate: isDtw
            ? `<b>${w.swn}</b><br>%{x}<br>%{y:.1f} ft below GSE<extra></extra>`
            : `<b>${w.swn}</b><br>%{x}<br>%{y:.1f} ft msl<extra></extra>`,
          visible,
        });
        here.push(tIdx++);
      }

      // Per-well thresholds for 2027 RMS wells.
      // For multi-primary aggregates (Chico), only draw threshold lines for
      // the currently-selected primary well (currentSelection.primaryWell).
      // All other wells still plot their hydrograph traces above.
      const activePrimary = currentSelection?.primaryWell;
      if (w.is_2027_gwl_rms && (!activePrimary || w.swn === activePrimary)) {
        const gse = w.gse != null ? +w.gse : null;
        const isMirror = w.threshold_source === "AGWL Mirror";
        const sourceSuffix = isMirror ? " (AGWL mirror)" : "";
        const addThr = (val, label, lineColor, dashAdopted, dashMirror) => {
          if (val == null) return;
          let y, unitLabel;
          if (isDtw) {
            if (gse == null) return;
            y = gse - val;
            unitLabel = `${y.toFixed(1)} ft below GSE`;
          } else {
            y = val;
            unitLabel = `${y.toFixed(1)} ft msl`;
          }
          traces.push({
            x: ["1980-01-01", new Date().toISOString().slice(0, 10)],
            y: [y, y],
            mode: "lines", type: "scatter",
            name: `${w.swn} ${label}: ${unitLabel}${sourceSuffix}`,
            line: { color: lineColor, width: 1.6, dash: isMirror ? dashMirror : dashAdopted },
            hovertemplate: `${w.swn} ${label}${sourceSuffix}: ${unitLabel}<extra></extra>`,
            visible,
          });
          here.push(tIdx++);
        };
        // MO and MT: adopted=dash, mirror=dot
        addThr(w.mo_ft, "MO", "#2a7", "dash", "dot");
        addThr(w.mt_ft, "MT", "#c00", "dash", "dot");
        // IM-2027 keeps dot in both modes (matches existing convention)
        addThr(w.im_2027_ft, "IM-2027", "#6a3aa1", "dot", "dot");
        // Raised MT (sensitivity slider). Only drawn when slider > 0 and
        // only for the polygon's seed RMS well so the hydrograph doesn't
        // accumulate one raised line per well.
        const isPolySeed = (poly.rms_well_swn === w.swn) ||
          (poly.is_aggregate && (poly.rms_primary_swns || []).includes(w.swn));
        if (mtRaiseFt > 0 && w.mt_ft != null && isPolySeed) {
          addThr(w.mt_ft + mtRaiseFt,
                 `MT + ${mtRaiseFt} ft (sensitivity)`,
                 "#ff8c00", "dash", "dash");
        }
      }
      traceIndices[w.swn] = here;
    });
    if (currentSelection) currentSelection.traceIndices = traceIndices;

    // Drought shading (lowest layer)
    const shapes = DROUGHT_PERIODS.map(([x0, x1]) => ({
      type: "rect", xref: "x", yref: "paper",
      x0, x1, y0: 0, y1: 1,
      fillcolor: "rgba(255,152,0,0.10)", line: { width: 0 }, layer: "below",
    }));

    const yTitle = isDtw ? "Depth to Groundwater (ft below GSE)" : "Groundwater Elevation (ft msl)";
    const titleText = isDtw
      ? `Depth to Groundwater — ${poly.zone_label} (${insideWells.length} well${insideWells.length === 1 ? "" : "s"})`
      : `Groundwater Elevation — ${poly.zone_label} (${insideWells.length} well${insideWells.length === 1 ? "" : "s"})`;

    const layout = {
      title: { text: titleText, font: { size: 14 } },
      margin: { t: 40, l: 60, r: 16, b: 60 },
      xaxis: { title: "Date", type: "date", showgrid: true, gridcolor: "#eee" },
      yaxis: {
        title: yTitle,
        showgrid: true, gridcolor: "#eee",
        autorange: isDtw ? "reversed" : true,  // flip so MO is up, MT is down
      },
      hovermode: "closest",
      legend: { orientation: "h", y: -0.18, font: { size: 11 } },
      shapes,
      plot_bgcolor: "#fff", paper_bgcolor: "#fff",
    };
    Plotly.react("hydro", traces, layout, { responsive: true, displaylogo: false });

    // Sync the mode buttons' active state
    document.querySelectorAll(".hydro-controls .ctrl-btn[data-mode]").forEach((b) => {
      b.classList.toggle("active", b.getAttribute("data-mode") === mode);
    });
  }

  function setDisplayMode(mode) {
    if (!currentSelection) return;
    currentSelection.displayMode = mode;
    const insideWells = currentSelection.wellsWithColor.map((wc) => wc.well);
    renderHydrograph(currentSelection.poly, insideWells);
  }

  /* -------------- §5.3 sortable well detail table (cosmo-style) -------- */
  const TABLE_COLUMNS = [
    { key: "__show",  label: "Show",                  sortable: false, className: "show-col" },
    { key: "name",    label: "Well Name" },
    { key: "rms27",   label: "2027 RMS" },
    { key: "cont",    label: "Continuous" },
    { key: "record",  label: "Record" },
    { key: "flags",   label: "Quality Flags" },
    { key: "use",     label: "Well Use" },
    { key: "depth",   label: "Depth" },
    { key: "gse",     label: "GSE (ft msl)" },
    { key: "wse",     label: "Most Recent Reading" },
  ];

  function buildSortKeys(wc) {
    const w = wc.well;
    const stats = measurementSummary(getMeas(w));
    return {
      well: w,
      color: wc.color,
      stats,
      sort: {
        name: w.swn,
        rms27: w.is_2027_gwl_rms ? 0 : 1,          // RMS first
        cont: isContinuous(w) ? 0 : 1,             // Continuous first
        record: stats.firstYear ? parseInt(stats.firstYear, 10) : 9999,
        flags: stats.questionable + stats.missing, // fewer flags first
        use: w.well_use || "",
        depth: w.well_depth != null ? +w.well_depth : -1,
        gse: w.gse != null ? +w.gse : -1,
        wse: stats.lastGoodGwe != null ? stats.lastGoodGwe : -99999,
      },
    };
  }

  function sortRows(rows, col, dir) {
    const sign = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const va = a.sort[col], vb = b.sort[col];
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
      return String(va).localeCompare(String(vb)) * sign;
    });
  }

  function renderWellDetailTable() {
    const sel = currentSelection;
    if (!sel) return;
    const rows = sel.wellsWithColor.map(buildSortKeys);
    const sorted = sortRows(rows, sel.sortCol, sel.sortDir);

    const headerHtml = TABLE_COLUMNS.map((c) => {
      if (c.sortable === false || c.key === "__show") {
        return `<th class="${c.className || ""}">${c.label}</th>`;
      }
      const active = sel.sortCol === c.key;
      const arrow = active ? (sel.sortDir === "asc" ? "▲" : "▼") : "▲";
      const cls = active ? "sort-arrow" : "sort-arrow inactive";
      return `<th class="sortable" data-col="${c.key}">${c.label}<span class="${cls}">${arrow}</span></th>`;
    }).join("");

    const bodyHtml = sorted.map(({ well: w, color, stats }) => {
      const noDwr = !w.site_code;
      const checked = sel.visibility[w.swn] ? "checked" : "";
      const rmsPill = w.is_2027_gwl_rms
        ? '<span class="pill pill-rms">Yes</span>'
        : '<span class="pill pill-supp">No</span>';
      const contPill = isContinuous(w)
        ? '<span class="pill pill-cont">' + (w.monitor_freq || "Hourly") + '</span>'
        : '<span class="pill pill-supp">' + (w.monitor_freq || "—") + '</span>';
      const recordTxt = noDwr
        ? '<em style="color:#999;">no DWR data</em>'
        : (stats.firstYear ? `${stats.firstYear}–${stats.lastYear}` : "—");
      const goodTxt = noDwr ? "" : `${stats.good.toLocaleString()} good`;
      const flagsTxt = noDwr
        ? '<span style="color:#999;">—</span>'
        : ((stats.questionable + stats.missing) > 0
          ? `<span class="pill pill-flag">${stats.questionable} Q / ${stats.missing} M</span>`
          : '<span style="color:#999;">—</span>');
      const depth = w.well_depth != null ? `${Math.round(w.well_depth)} ft` : "—";
      const gse = w.gse != null ? (+w.gse).toFixed(2) : "—";
      const lastReading = noDwr
        ? '<em style="color:#999;">—</em>'
        : (stats.lastGoodGwe != null
          ? `${stats.lastGoodGwe.toFixed(2)} ft<br><span style="color:#888; font-size:11px;">${stats.lastGoodDate}</span>`
          : (() => {
            const wse = currentWSE(w);
            return wse
              ? `${wse.gwe.toFixed(2)} ft<br><span style="color:#888; font-size:11px;">${wse.date}${wse.qa ? ` (${wse.qa})` : ""}</span>`
              : "—";
          })());
      const nC = nestedCount(w);
      const nestedPill = nC > 1
        ? ` <span class="pill pill-nested" title="This site has ${nC} wells screened at different depths.">Nested ×${nC}</span>`
        : "";
      let thresholdPill = "";
      if (w.is_2027_gwl_rms && w.threshold_source) {
        const cls = w.threshold_source === "2022 GSP" ? "pill-thr-gsp" : "pill-thr-mirror";
        const label = w.threshold_source === "2022 GSP" ? "GSP-adopted MT/MO" : "AGWL mirror MT/MO";
        const tip = w.threshold_source === "2022 GSP"
          ? "Thresholds carried over unchanged from the adopted 2022 Vina GSP."
          : "Baseline thresholds derived from each well's average Feb-April groundwater level, anchored to the per-zone offset between AGWL and adopted 2022 GSP MT/MO/IM (Christina Buck AGWL Mirror methodology). Pending GSA review.";
        thresholdPill = ` <span class="pill ${cls}" title="${tip}">${label}</span>`;
      }
      const bcReason = (w.butte_co_reasoning || "").trim();
      // Show BC reasoning for ANY well that has it (not just RMS).
      // Use the well's SWN explicitly in the label so it's unambiguous which
      // row the note refers to.
      const reasoningRow = bcReason
        ? `<tr class="reasoning-row"><td colspan="${TABLE_COLUMNS.length}">
             <span class="reasoning-label" style="color:${color};">${w.swn}</span>
             — <span class="reasoning-text">${bcReason}</span>
           </td></tr>`
        : "";
      return `
        <tr>
          <td class="show-col">
            <input type="checkbox" data-well-toggle data-swn="${w.swn}" ${checked}>
          </td>
          <td class="well-name-cell" style="color:${color};">
            <span class="color-swatch" style="background:${color};"></span>${w.swn}${nestedPill}${thresholdPill}
          </td>
          <td>${rmsPill}</td>
          <td>${contPill}</td>
          <td>${recordTxt}${goodTxt ? `<br><span style="color:#888; font-size:11px;">${goodTxt}</span>` : ""}</td>
          <td>${flagsTxt}</td>
          <td>${w.well_use || "—"}</td>
          <td>${depth}</td>
          <td>${gse}</td>
          <td>${lastReading}</td>
        </tr>${reasoningRow}`;
    }).join("");

    $("#well-detail-table-container").innerHTML =
      `<table class="well-detail-table"><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;

    // Wire up column sort
    document.querySelectorAll(".well-detail-table th.sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const col = th.getAttribute("data-col");
        if (sel.sortCol === col) sel.sortDir = sel.sortDir === "asc" ? "desc" : "asc";
        else { sel.sortCol = col; sel.sortDir = "asc"; }
        renderWellDetailTable();
      });
    });
    // Wire up per-row checkbox
    document.querySelectorAll(".well-detail-table input[data-well-toggle]").forEach((cb) => {
      cb.addEventListener("change", () => toggleWell(cb.getAttribute("data-swn"), cb.checked));
    });
  }

  function toggleWell(swn, visible) {
    const sel = currentSelection;
    if (!sel) return;
    sel.visibility[swn] = visible;
    const vis = visible ? true : "legendonly";
    const hIdx = sel.traceIndices[swn] || [];
    if (hIdx.length) Plotly.restyle("hydro", { visible: vis }, hIdx);
    const sIdx = (sel.scatterTraceIndices || {})[swn] || [];
    if (sIdx.length && document.querySelector("#scatter .main-svg")) {
      Plotly.restyle("scatter", { visible: vis }, sIdx);
    }
  }

  function toggleAllWells(visible) {
    const sel = currentSelection;
    if (!sel) return;
    Object.keys(sel.visibility).forEach((k) => { sel.visibility[k] = visible; });
    const vis = visible ? true : "legendonly";
    const allHydroIdx = [];
    Object.values(sel.traceIndices).forEach((arr) => arr.forEach((i) => allHydroIdx.push(i)));
    if (allHydroIdx.length) Plotly.restyle("hydro", { visible: vis }, allHydroIdx);
    const allScatterIdx = [];
    Object.values(sel.scatterTraceIndices || {}).forEach((arr) => arr.forEach((i) => allScatterIdx.push(i)));
    if (allScatterIdx.length && document.querySelector("#scatter .main-svg")) {
      Plotly.restyle("scatter", { visible: vis }, allScatterIdx);
    }
    document.querySelectorAll(".well-detail-table input[data-well-toggle]").forEach((cb) => { cb.checked = visible; });
  }

  /* -------------- 5.4 scatter ------------------------------------------ */
  function populateRMSPicker(poly) {
    const sel = $("#picker-rms");
    sel.innerHTML = "";
    const insideWells = polygonWells(poly);
    let rmsInside = insideWells.filter((w) => w.is_2027_gwl_rms);
    if (rmsInside.length === 0) {
      // Fall back to the seed well
      const seed = WELLS.find((w) => w.swn === poly.rms_well_swn);
      if (seed) rmsInside = [seed];
    }
    rmsInside.forEach((w) => {
      const opt = document.createElement("option");
      opt.value = w.swn;
      opt.textContent = w.swn;
      sel.appendChild(opt);
    });
    sel.value = rmsInside[0]?.swn || "";
    sel.onchange = () => renderScatter(poly, sel.value);
    renderScatter(poly, sel.value);
  }

  function renderScatter(poly, rmsSwn) {
    const ref = WELLS.find((w) => w.swn === rmsSwn);
    if (!ref) { Plotly.purge("scatter"); return; }
    const refMs = MEASUREMENTS[ref.site_code] || [];
    // index ref measurements by YYYY-MM
    const refByMonth = {};
    refMs.forEach((m) => {
      if (m.gwe == null) return;
      const k = (m.d || "").slice(0, 7);
      if (!refByMonth[k] || m.qa === "Good") refByMonth[k] = m.gwe;
    });

    // Use the same well order (and colors) as §5.3 hydrograph
    const wellsWithColor = currentSelection?.wellsWithColor
      || polygonWells(poly).map((w, i) => ({ well: w, color: TRACE_COLORS[i % TRACE_COLORS.length] }));

    const traces = [];
    const scatterTraceIndices = {};
    const stats = [];
    let tIdx = 0;

    wellsWithColor.forEach(({ well: w, color }) => {
      if (w.swn === rmsSwn) return;   // skip the reference well itself
      const ms = MEASUREMENTS[w.site_code] || [];
      const xs = [], ys = [], dates = [];
      ms.forEach((m) => {
        if (m.gwe == null) return;
        const k = (m.d || "").slice(0, 7);
        const refVal = refByMonth[k];
        if (refVal == null) return;
        xs.push(refVal);
        ys.push(m.gwe);
        dates.push(m.d);
      });
      if (xs.length === 0) return;
      const r = pearson(xs, ys);
      const r2 = r != null ? r * r : null;
      const label = `${w.swn} (n=${xs.length}${r2 != null ? `, R²=${r2.toFixed(2)}` : ""})`;
      const visible = currentSelection ? (currentSelection.visibility[w.swn] ? true : "legendonly") : true;
      traces.push({
        x: xs, y: ys,
        type: "scatter", mode: "markers",
        name: label,
        marker: { color, size: 6, opacity: 0.75, line: { width: 0.5, color: "#fff" } },
        text: dates,
        hovertemplate: `<b>${w.swn}</b><br>%{text}<br>ref=%{x:.1f}, this=%{y:.1f}<extra></extra>`,
        visible,
      });
      scatterTraceIndices[w.swn] = [tIdx++];
      stats.push({ swn: w.swn, n: xs.length, r2 });
    });

    // 1:1 line spanning union range
    let allX = [], allY = [];
    traces.forEach((t) => { allX = allX.concat(t.x); allY = allY.concat(t.y); });
    if (allX.length > 0) {
      const lo = Math.min(...allX, ...allY);
      const hi = Math.max(...allX, ...allY);
      traces.push({
        x: [lo, hi], y: [lo, hi],
        type: "scatter", mode: "lines",
        name: "1:1",
        line: { color: "#888", width: 1.5, dash: "dash" },
        hoverinfo: "skip", showlegend: true,
      });
      // 1:1 line is not tracked in scatterTraceIndices (it's always shown)
    }

    if (currentSelection) currentSelection.scatterTraceIndices = scatterTraceIndices;

    const layout = {
      title: { text: `RMS reference: ${rmsSwn} · ${stats.length} comparison well(s)`, font: { size: 14 } },
      margin: { t: 40, l: 60, r: 20, b: 60 },
      xaxis: { title: `Reference GWE — ${rmsSwn} (ft msl)`, gridcolor: "#eee" },
      yaxis: { title: "Comparison well GWE (ft msl)", gridcolor: "#eee" },
      legend: { orientation: "v", x: 1.02, y: 1, font: { size: 11 } },
      hovermode: "closest",
      plot_bgcolor: "#fff", paper_bgcolor: "#fff",
    };
    Plotly.react("scatter", traces, layout, { responsive: true, displaylogo: false });

    const summary = stats.length
      ? `${stats.length} comparison well(s) paired by month. Best R²: ${
          Math.max(...stats.map((s) => s.r2 || 0)).toFixed(2)
        }`
      : "No paired same-month measurements available for this polygon.";
    $("#scatter-info").textContent = summary;
  }

  /* -------------- §5.3 MT-sensitivity widget wiring -------------------- */
  function renderSensitivityTable() {
    if (!currentSelection) return;
    const poly = currentSelection.poly;
    const polyMT = polygonMT(poly);
    const polyGSE = polygonRmsGSE(poly);
    const polyWells = DOMESTIC_BY_POLYGON[poly.zone_label] || [];
    const polyTotal = polyWells.length;
    const polyLabel = poly.is_aggregate
      ? `Chico polygon (n=${polyTotal})`
      : `${poly.zone_label} (n=${polyTotal})`;

    // Active column: closest 5-ft step to the slider value
    const activeRaise = SENS_RAISES.reduce((best, r) =>
      Math.abs(r - mtRaiseFt) < Math.abs(best - mtRaiseFt) ? r : best, 0);

    const cellHtml = (cnt, total, isActive) => {
      const pct = total > 0 ? (100 * cnt / total) : 0;
      return `<td class="${isActive ? 'sens-current' : ''}">
        <span class="sens-pct">${pct.toFixed(0)}%</span>
        <span class="sens-count">${cnt} of ${total}</span>
      </td>`;
    };

    // Subbasin row
    const basinRow = SENS_RAISES.map((r) => {
      const c = basinDryCount(r, elevCorrectionOn);
      return cellHtml(c.dry, c.total, r === activeRaise);
    }).join("");
    $("#sens-row-basin").innerHTML =
      `<td class="sens-scope">Subbasin (n=${DOMESTIC_ACTIVE.length} domestic wells)</td>` + basinRow;

    // Per-polygon row
    if (polyTotal === 0) {
      const empty = SENS_RAISES.map(() => `<td style="color:#888;">—</td>`).join("");
      $("#sens-row-polygon").innerHTML =
        `<td class="sens-scope">${polyLabel} (no domestic wells)</td>` + empty;
    } else {
      const polyRow = SENS_RAISES.map((r) => {
        const c = countDryDomestic(polyWells, polyMT, polyGSE, r, elevCorrectionOn);
        return cellHtml(c.dry, c.total, r === activeRaise);
      }).join("");
      $("#sens-row-polygon").innerHTML =
        `<td class="sens-scope">${polyLabel}</td>` + polyRow;
    }
  }

  function onSensitivityChange() {
    renderSensitivityTable();
    // Re-render the hydrograph to show/move the raised MT line.
    if (currentSelection) {
      const insideWells = currentSelection.wellsWithColor.map((wc) => wc.well);
      renderHydrograph(currentSelection.poly, insideWells);
    }
  }

  /* -------------- bootstrap --------------------------------------------- */
  function bootstrap() {
    buildDomesticCaches();
    renderKPIs();
    renderMap();
    populatePolygonPicker();
    $("#show-all-wells").addEventListener("click", () => toggleAllWells(true));
    $("#hide-all-wells").addEventListener("click", () => toggleAllWells(false));
    $("#mode-gwe").addEventListener("click", () => setDisplayMode("gwe"));
    $("#mode-dtw").addEventListener("click", () => setDisplayMode("dtw"));
    // MT sensitivity wiring
    $("#mt-raise-slider").addEventListener("input", (e) => {
      mtRaiseFt = +e.target.value;
      $("#mt-raise-display").textContent = `+${mtRaiseFt} ft`;
      onSensitivityChange();
    });
    $("#tog-elev-correction").addEventListener("change", (e) => {
      elevCorrectionOn = e.target.checked;
      onSensitivityChange();
    });
    // Auto-select first polygon
    if (RMS_POLYGONS.length > 0) {
      const first = RMS_POLYGONS.slice().sort((a, b) => a.zone_label.localeCompare(b.zone_label))[0];
      selectPolygon(first.zone_label);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap);
  } else {
    bootstrap();
  }
})();
