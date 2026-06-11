"""Build data/thresholds.json — MT/MO/IM-2027 for the 2027 RMS network.

Post-2026-05-21 revision: AGWL Mirror methodology (Christina Buck, BCWRC).
Replaces the prior buffer-based "2022 Mirror" methodology.

Two distinct paths depending on whether the well was an RMS in the 2022 GSP:

(A) 2022 GSP carryovers (12 wells) — values unchanged from the 2022 GSP:
    - 5 North: 22N01W05M001M, 23N01E07H001M, 23N01E33A001M,
      23N01W36P001M, 23N02W25C001M
    - 3 South: 20N02E24C001M, 21N02E18C003M, 21N02E26E006M (inherits
      from its nested sibling 21N02E26E005M, same lat/lng)
    - 4 Chico: CWSCH01b, CWSCH02, CWSCH03, CWSCH07

(B) AGWL Mirror (17 new wells: 8 N + 9 S) — derived from a zone-average
    offset between AGWL and the 2022 GSP MT/MO/IM at the 2022 RMS wells.

    Step 1 — for each 2022 RMS well, compute:
        AGWL = mean of QA-Good GWE measurements falling in Feb, Mar, Apr
               months across the full DWR record.
        ΔGWL→MT = AGWL - MT_2022_RMS
        ΔGWL→MO = AGWL - MO_2022_RMS
        ΔGWL→IM = AGWL - IM_2022_RMS

    Step 2 — average per management area:
        Region    n RMS used   AveΔGWL→MT (ft)
        North     6            ~91
        South     6            ~92
        Chico     5            ~43  (all 4 CWSCH + 22N01E28J003M)

    Step 3 — for each non-carryover 2027 RMS well:
        AGWL_well  = same Feb-April mean over the well's full record
        zone       = well's NETWORK assignment (rms_mgmt_area; falls back
                     to mgmt_area_full if not overridden)
        MT_ft      = round(AGWL_well - AveΔGWL→MT_zone)
        MO_ft      = round(AGWL_well - AveΔGWL→MO_zone)
        IM_2027_ft = round(AGWL_well - AveΔGWL→IM_zone)

    Notes on zone keying:
    - Zone offsets for new wells use rms_mgmt_area, not geographic
      mgmt_area_full. The 2 wells that are RMS for the North network but
      physically inside Chico (22N01E09B001M, 22N01E20K001M) use the
      North zone offsets, consistent with their network role.
    - Chico zone offset is computed for documentation but is not applied
      to any well in the 2027 network. All 4 Chico RMS wells
      (CWSCH01b/02/03/07) are 2022 GSP carryovers. No new RMS wells
      are assigned to the Chico network via AGWL Mirror.

    Notes on spring window (Feb-April):
    - Selected by BCWRC staff after reviewing the three-variant
      sensitivity analysis (Feb-May, Feb-April, Highest March) in
      analysis/agwl_window_comparison.md.
    - Captures spring conditions weighted toward post-recharge /
      pre-pumping. Excludes May, which tends to show declines from
      evapotranspiration onset.

Source labels in the output:
    "2022 GSP"     — adopted carryovers (9 wells). Visualized with dashed
                     threshold lines and a blue pill in §5.3.
    "AGWL Mirror"  — new AGWL-based derivation (17 wells). Visualized
                     with dotted threshold lines and a warm-cream pill.

Caveats baked into the README/PROJECT_NOTES:
- AGWL reflects the OBSERVED Feb-April record. Wells with short records
  or sparse monitoring may understate or overstate typical conditions —
  estimates from such wells should be considered conservative.
- The dry-well count at MT shown elsewhere in the dashboard is a
  sensitivity snapshot, not a forecast. The subbasin manages to MO, not
  MT. Observed dry wells through both 2014-25 droughts: ~35.
- Adopted MT/MO/IM remain the 2022 GSP values until the GSA formally
  updates them in the 2027 GSP cycle. The Mirror remains an internal
  working baseline for the dashboard.
"""
from __future__ import annotations

import json
import re
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WELLS_JSON = ROOT / "data" / "wells_resolved.json"
CARRYOVER_JSON = ROOT / "data" / "thresholds_2022.json"
MEAS_JS = ROOT / "js" / "measurements-data.js"
OUT = ROOT / "data" / "thresholds.json"

SPRING_MONTHS = {2, 3, 4}  # Feb, March, April — staff-selected window
LOW_DATA_THRESHOLD = 5     # fewer than this many spring readings = flag


def load_measurements() -> dict:
    text = MEAS_JS.read_text()
    m = re.search(r"const MEASUREMENTS\s*=\s*({.*});", text, re.S)
    if not m:
        raise SystemExit("Could not parse MEASUREMENTS from js/measurements-data.js")
    return json.loads(m.group(1))


def qa_good(records: list[dict]) -> list[dict]:
    """QA-Good readings with non-null GWE."""
    return [
        r for r in records
        if r.get("gwe") is not None
        and r.get("qa")
        and "good" in r["qa"].lower()
    ]


def month_of(r: dict) -> int | None:
    try:
        return int(r["d"][5:7])
    except (KeyError, ValueError, IndexError):
        return None


def spring_records(records: list[dict]) -> list[dict]:
    """QA-Good GWE in Feb-April months across all years."""
    return [r for r in qa_good(records) if month_of(r) in SPRING_MONTHS]


def agwl_for_site(meas: dict, site_code: str) -> tuple[float | None, int]:
    """Returns (AGWL_Feb-April, n_measurements) for a site_code."""
    recs = spring_records(meas.get(site_code, []))
    if not recs:
        return None, 0
    return statistics.mean(r["gwe"] for r in recs), len(recs)


def compute_zone_offsets(
    wells: list[dict],
    wells_by_swn: dict,
    carry_by_swn: dict,
    meas: dict,
) -> tuple[dict, dict]:
    """Compute AveΔGWL_MT/_MO/_IM per management area from the 2022 RMS wells.

    Returns:
        zone_offsets: dict[zone_name -> {'ave_delta_mt', '_mo', '_im',
                                          'n_wells', 'ave_agwl'}]
        rms_2022_detail: dict[swn -> {'agwl', 'mt22', 'mo22', 'im22',
                                       'delta_mt', '_mo', '_im', 'n_obs'}]
            Used downstream for diagnostic printing.
    """
    rms_2022_by_zone: dict[str, list[str]] = {}
    for w in wells:
        if w.get("is_2022_gwl_rms"):
            rms_2022_by_zone.setdefault(w["mgmt_area_full"], []).append(w["swn_or_name"])

    rms_2022_detail: dict[str, dict] = {}
    for zone, swns in rms_2022_by_zone.items():
        for swn in swns:
            w = wells_by_swn[swn]
            t22 = carry_by_swn.get(swn)
            agwl, n = agwl_for_site(meas, w["site_code"])
            rec = {
                "zone": zone, "agwl": agwl, "n_obs": n,
                "mt22": t22["mt_ft"] if t22 else None,
                "mo22": t22["mo_ft"] if t22 else None,
                "im22": t22["im_2027_ft"] if t22 else None,
            }
            rec["delta_mt"] = (agwl - rec["mt22"]) if (agwl is not None and rec["mt22"] is not None) else None
            rec["delta_mo"] = (agwl - rec["mo22"]) if (agwl is not None and rec["mo22"] is not None) else None
            rec["delta_im"] = (agwl - rec["im22"]) if (agwl is not None and rec["im22"] is not None) else None
            rms_2022_detail[swn] = rec

    zone_offsets: dict[str, dict] = {}
    for zone, swns in rms_2022_by_zone.items():
        d_mt = [rms_2022_detail[s]["delta_mt"] for s in swns if rms_2022_detail[s]["delta_mt"] is not None]
        d_mo = [rms_2022_detail[s]["delta_mo"] for s in swns if rms_2022_detail[s]["delta_mo"] is not None]
        d_im = [rms_2022_detail[s]["delta_im"] for s in swns if rms_2022_detail[s]["delta_im"] is not None]
        agwl_vals = [rms_2022_detail[s]["agwl"] for s in swns if rms_2022_detail[s]["agwl"] is not None]
        zone_offsets[zone] = {
            "n_wells": len(swns),
            "ave_agwl": statistics.mean(agwl_vals) if agwl_vals else None,
            "ave_delta_mt": statistics.mean(d_mt) if d_mt else None,
            "ave_delta_mo": statistics.mean(d_mo) if d_mo else None,
            "ave_delta_im": statistics.mean(d_im) if d_im else None,
        }
    return zone_offsets, rms_2022_detail


def main() -> None:
    wells = json.loads(WELLS_JSON.read_text())
    carry = {t["swn"]: t for t in json.loads(CARRYOVER_JSON.read_text())}
    meas = load_measurements()
    wells_by_swn = {w["swn_or_name"]: w for w in wells}

    zone_offsets, rms_2022_detail = compute_zone_offsets(wells, wells_by_swn, carry, meas)

    print("\n=== AGWL Mirror — zone offsets (ft, derived from 2022 RMS, Feb-April) ===")
    print(f"{'Zone':<18} {'n':>3} {'AveAGWL':>10} {'dMT':>8} {'dMO':>8} {'dIM':>8}")
    for zone in ["01-Vina-North", "02-Vina-Chico", "03-Vina-South"]:
        zo = zone_offsets.get(zone)
        if not zo:
            continue
        agwl_s = f"{zo['ave_agwl']:.2f}" if zo['ave_agwl'] is not None else "—"
        print(f"{zone:<18} {zo['n_wells']:>3} {agwl_s:>10} "
              f"{zo['ave_delta_mt']:>8.2f} {zo['ave_delta_mo']:>8.2f} {zo['ave_delta_im']:>8.2f}")

    out = []
    for w in wells:
        if not w["is_2027_gwl_rms"]:
            continue
        name = w["swn_or_name"]
        site = w["site_code"]
        recs_qa = qa_good(meas.get(site, []))
        spring_recs = spring_records(meas.get(site, []))
        n_spring = len(spring_recs)
        agwl, _ = agwl_for_site(meas, site)
        alltime_min = min((r["gwe"] for r in recs_qa), default=None)

        # ---- 2022 GSP carryover path -------------------------------
        # Either the well was a 2022 RMS itself, or it inherits from a
        # nested sibling that was (e.g. 21N02E26E006M inheriting from
        # 21N02E26E005M, same lat/lng but different completion depth).
        carry_swn = name if name in carry else w.get("carryover_from")
        if carry_swn and carry_swn in carry:
            t = carry[carry_swn]
            note = (
                f"inherited from {carry_swn} (nested sibling)"
                if carry_swn != name else None
            )
            rec = {
                "swn": name,
                "site_code": site,
                "mgmt_area_full": w["mgmt_area_full"],
                "source": "2022 GSP",
                "mt_ft": t["mt_ft"],
                "mo_ft": t["mo_ft"],
                "im_2027_ft": t["im_2027_ft"],
                "agwl_ft": round(agwl, 2) if agwl is not None else None,
                "alltime_min": round(alltime_min, 2) if alltime_min is not None else None,
                "n_spring_obs": n_spring,
                "low_spring_data": n_spring < LOW_DATA_THRESHOLD,
                "carryover_from": carry_swn if carry_swn != name else None,
                "note": note,
            }
            out.append(rec)
            continue

        # ---- AGWL Mirror — new methodology -------------------------
        # Zone offset is keyed on rms_mgmt_area (network assignment).
        # For most wells this equals mgmt_area_full; for the 2 Chico-
        # located wells that are RMS-for-North, rms_mgmt_area =
        # "01-Vina-North" so they get the North offset.
        rms_ma = w.get("rms_mgmt_area", w["mgmt_area_full"])
        zo = zone_offsets.get(rms_ma)

        if agwl is None or zo is None or zo["ave_delta_mt"] is None:
            rec = {
                "swn": name,
                "site_code": site,
                "mgmt_area_full": w["mgmt_area_full"],
                "rms_mgmt_area": rms_ma,
                "source": "AGWL Mirror (no GWE data)",
                "mt_ft": None,
                "mo_ft": None,
                "im_2027_ft": None,
                "agwl_ft": None,
                "alltime_min": None,
                "n_spring_obs": n_spring,
                "low_spring_data": True,
            }
            out.append(rec)
            continue

        mt_ft = round(agwl - zo["ave_delta_mt"])
        mo_ft = round(agwl - zo["ave_delta_mo"]) if zo["ave_delta_mo"] is not None else None
        im_ft = round(agwl - zo["ave_delta_im"]) if zo["ave_delta_im"] is not None else None

        rec = {
            "swn": name,
            "site_code": site,
            "mgmt_area_full": w["mgmt_area_full"],
            "rms_mgmt_area": rms_ma,
            "source": "AGWL Mirror",
            "mt_ft": mt_ft,
            "mo_ft": mo_ft,
            "im_2027_ft": im_ft,
            "agwl_ft": round(agwl, 2),
            "alltime_min": round(alltime_min, 2) if alltime_min is not None else None,
            "n_spring_obs": n_spring,
            "low_spring_data": n_spring < LOW_DATA_THRESHOLD,
            "zone_offset_mt": round(zo["ave_delta_mt"], 2),
            "zone_offset_mo": round(zo["ave_delta_mo"], 2) if zo["ave_delta_mo"] is not None else None,
            "zone_offset_im": round(zo["ave_delta_im"], 2) if zo["ave_delta_im"] is not None else None,
        }
        out.append(rec)

    out.sort(key=lambda r: r["swn"])

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2))

    n_adopted = sum(1 for r in out if r["source"] == "2022 GSP")
    n_mirror = sum(1 for r in out if r["source"].startswith("AGWL Mirror"))
    n_low = sum(1 for r in out if r.get("low_spring_data") and r["source"].startswith("AGWL Mirror"))
    print(f"\nWrote {OUT}")
    print(f"  total RMS wells: {len(out)}")
    print(f"    adopted (2022 GSP):  {n_adopted}")
    print(f"    new (AGWL Mirror):   {n_mirror}")
    print(f"      ...with thin spring data (<{LOW_DATA_THRESHOLD}): {n_low}")

    print(f"\n{'Well':<18} {'mgmt':<15} {'source':<14} {'AGWL':>8} "
          f"{'MT':>5} {'MO':>5} {'IM':>5} {'n_spr':>6}")
    print("-" * 95)
    for r in out:
        agwl_s = f"{r.get('agwl_ft'):.1f}" if r.get('agwl_ft') is not None else "—"
        mt = str(r['mt_ft']) if r['mt_ft'] is not None else "—"
        mo = str(r['mo_ft']) if r['mo_ft'] is not None else "—"
        im = str(r['im_2027_ft']) if r['im_2027_ft'] is not None else "—"
        print(f"{r['swn']:<18} {r['mgmt_area_full']:<15} {r['source']:<14} "
              f"{agwl_s:>8} {mt:>5} {mo:>5} {im:>5} {r.get('n_spring_obs', 0):>6}")


if __name__ == "__main__":
    main()
