# Modeled WSE Derivation Method `m5-flowline-profile-jarrett-depth`

Version 1 (experimental). Data-Product Version `m5-v1` once frozen. Stages 0–2 are shared with m1; Stage 3 runs from `stage-03-flowline-profile-jarrett-time-series.ts` in this folder. Like m4, it has no polygon version of its own: `flowline-channel-ribbon` v2 (built from `m3-v2`) draws it through a channel pairing (METHODOLOGY.md, "Channel pairing").

```text
npm run pipeline:modeled-wse:m5-time-series -- --extent=dangermond-preserve --modeled-wse-method=m5-flowline-profile-jarrett-depth
```

Browser: `?wsePolygonMethod=flowline-channel-ribbon@v2&modeledWse=m5-flowline-profile-jarrett-depth@v1`, or Dev tools → Derived data products → Modeled WSE version "m5-v1".

## What it does

m5 is m4 (`m4-flowline-profile-variable-power-depth`) with a different steep-creek law. Everything else is the same code:
- m3 v2's channel, raw lidar bed, anchor, cross-section, slope, discharge, ladder, inversion, junction depths, pool-filled water surface and Time Series fields;
- m4's copied rating-curve builder, anchor section cut, Stage 3, channel guard and blend (`STEEP_CREEK_ROUGHNESS_BLEND`, imported from m4's `method-config.ts`).

So an m4 → m5 difference comes from the law alone, and an m3 v2 → m5 difference from the roughness alone. Read m4's METHOD.md for the blend, the divided channel, what is copied and why, and the channel pairing.

1. **Steep-creek law: Jarrett (1984), SI form:** n = 0.32 · S^0.38 · R^−0.16.
   - S is the slope (m/m) and R = A/P the subsection's hydraulic radius (m).
   - The US customary form is 0.39 with R in feet; 0.39 × 3.281^−0.16 = 0.32.
   - It was fitted on 75 measurements in 21 Colorado cobble and boulder streams at slopes 0.2–4% and hydraulic radii 0.15–2.1 m. The HEC-RAS technical reference lists it.
   - It needs no grain size, which is why Will prefers it in principle.
   - Citation: Jarrett, R.D. (1984), Hydraulics of high-gradient streams, *Journal of Hydraulic Engineering* 110(11):1519–1539, doi:10.1061/(ASCE)0733-9429(1984)110:11(1519).
2. **Per subsection, blended** (`flow-resistance.ts` here, `steepCreekSubsectionRoughness` in m4's). At every 2 cm ladder step, the main channel and each floodplain get Jarrett's n from their own R. The subsection discharge is then (1/n) A R^(2/3) S^(1/2).
   - The n is blended with m4's rule: Manning's n (0.04 / 0.07) at S ≤ 2%, Jarrett at S ≥ 8%, ln n linear in ln S between.
   - The effective n never drops below Manning's.
   - A segment whose anchor slope is 2% or less gets m3 v2's rating curve value for value.

## Why the depths are reasonable

| | m3 v2 | m4 | m5 |
| --- | --- | --- | --- |
| 27714697-040…045 at 2023-01-10T01Z: rating depth | 5.5–7.7 cm | 12.4–20.0 cm | 12.7–20.0 cm |
| … velocity | 1.06–2.67 m/s | 0.37–0.58 m/s | 0.36–0.57 m/s |
| … Froude | 1.66–3.83 | 0.38–0.54 | 0.37–0.53 |
| … effective n | 0.039–0.040 | 0.20–0.32 | 0.21–0.33 |
| Same reach at 2019-01-17T13Z (low flow): rating depth | dry–1.6 cm | 3.5–6.2 cm | 2.7–4.6 cm |
| Slopes 8–15% at the peak: median Froude, share above 1 | 1.89, 100% | 0.97, 49% | 0.52, 0% |
| Slopes 2–8% at the peak | 1.40, 96% | 1.20, 75% | 0.81, 19% |
| Median depth ratio to m3 v2 at the peak, slopes 2–8% / 8–15% / 15–30% / > 30% | 1 | 1.03 / 1.36 / 1.55 / 1.62 | 1.29 / 1.80 / 1.96 / 2.07 |

- On the steep reach at the peak, m4 and m5 agree within about 4%, from two independent laws; the research report found the same on m3 v1's channel (m5 13.2–22.8 cm, Froude 0.36–0.48). Their gap is a direct read of model uncertainty there.
- m5 is more aggressive than m4 on moderate slopes and at high flow, because n ∝ S^0.38 keeps rising with slope while VPEc relaxes toward Manning in deep water.
- At low flow on very steep creeks m5 is shallower than m4. There Jarrett's n (0.23–0.45) is lower than VPEc's (0.5–0.86 at h/D84 ≈ 0.1).

## Known limitations

- **Extrapolated 2.5–15× in slope.** Jarrett's data stop at about 4% (sources give 3.4–4%); the Preserve's anchors reach 62%. Above about 20% its n keeps rising, to 0.33 at 62% at the peak, which is at the top of the USFS 0.1–0.3 bankfull range for step-pool and cascade channels.
- **Fitted on Colorado cobble and boulder streams**, not coastal sedimentary creeks.
- **Reach-averaged law on one section**, and nothing for wood or bedrock steps, as m4.
- **More of the moderate-slope network changes.** At 2–8%, the median depth at the peak is 1.29 × m3 v2's (m4: 1.03 ×).
- **Flat creeks are not untouched in the Time Series.** A flat segment's own rating curve is m3 v2's, but its junction depths average the anchor depths of the wet segments within ±100 m. Steeper neighbours move them more than in m4.
  - Over all hours, 236 of 650 flat segments stay within 1 mm and 414 move more than 1 mm at some hour (411 through a junction depth). 8.1% of their values differ by more than 1 mm.
  - At the peak: 394 move more than 1 mm, 290 more than 1 cm and 46 more than 10 cm. The largest move is 0.608 m on 27714661-001 (1.5% slope, between neighbours at 3.0% and 6.2%), whose junction depths rise from 2.18/2.13 m to 2.76/2.75 m.
  - The Jalama gauge segment 27714637-026 rises 0.046 m at the peak (31.414 → 31.460 m), because its upstream neighbour 025 (2.35%) is inside the blend. At 2019-01-17T13Z it rises 0.012 m.
- **Ribbon ceiling.** The same 42 hourly values on 15 deep segments of 27714639 lie above ribbon v2's 8 m top rung, as in m3 v2. m5 adds none.

## Results (dangermond-preserve, v1)

- 3,338 Creek Segments. 650 anchor ratings use Manning only, 1,723 are blended and 919 use Jarrett only. 43 segments are null (wholly on a breach), as in m3 v2.
- 85 hourly values are clamped at the rating curve's top.
- Chart = drawing on ribbon v2 within 0.5 mm on every wet segment at 2023-01-09T12Z, 10T01Z, 14T12Z and 2019-01-17T13Z (11,870 segment-hours). No station is drawn below its bed, and every drawn boundary pair is identical.
- No negative depth among 155,522,374 values. Beds are identical to m3 v2's in every file.
- 27714697-044 at the peak: WSE 249.215 m, depth at the anchor 0.173 m. The water drawn at the anchor is 0.055 m above the browser terrain; m3 v2's was 0.050 m below it.
- Output: 2.0 GB of Time Series in 736 files; the largest file is 14.9 MB. Stage 3 takes 176 s.

## Version history

| Version | Change |
| --- | --- |
| 1 | New method: m3 v2 with Jarrett's (1984) flow resistance, blended from Manning's n over 2–8% slope as in m4, on m3 v2's channel. |
