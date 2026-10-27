# Modeled WSE Derivation Method `m4-flowline-profile-variable-power-depth`

Version 1 (experimental). Data-Product Version `m4-v1` once frozen. Stages 0–2 are shared with m1; Stage 3 runs from `stage-03-flowline-profile-variable-power-time-series.ts` in this folder. There is no polygon version of its own: `flowline-channel-ribbon` v2 (built from `m3-v2`) draws it through a channel pairing (METHODOLOGY.md, "Channel pairing").

```text
npm run pipeline:modeled-wse:m4-time-series -- --extent=dangermond-preserve --modeled-wse-method=m4-flowline-profile-variable-power-depth
```

Browser: `?wsePolygonMethod=flowline-channel-ribbon@v2&modeledWse=m4-flowline-profile-variable-power-depth@v1`, or Dev tools → Derived data products → Modeled WSE version "m4-v1".

## What it does

m4 is `m3-flowline-profile-manning-depth` v2 in every respect except flow resistance. The channel, raw lidar bed, barrier breaches, water-surface stations, WSE Anchor Point, anchor cross-section, ±30 m slope, drainage-area-ratio discharge, 2 cm ladder, inversion, 1 cm dry rule, junction depths, the smoothed pool-filled water surface and the Time Series fields are all m3 v2's. An m3 v2 → m4 difference is therefore flow-resistance physics only. Read m3's METHOD.md for everything below the roughness.

Manning's equation with a fixed n (0.04 channel, 0.07 floodplain) makes steep creeks too fast and too thin. At the January 2023 peak, m3 v2 has 6–8 cm of water at 1.1–2.7 m/s with Froude numbers 1.7–3.8 on 27714697-040…045 (slopes 12–62%). Field data on step-pool and cascade creeks give reach-averaged Froude numbers of about 0.3–0.8 (Yochum et al. 2012; Comiti et al. 2007; Palucis & Lamb 2017) and bankfull n of 0.1–0.3, up to 0.5 (Yochum 2018, USFS TS-103.2). m4 lets the roughness rise with slope using a published law fitted on field measurements, not guessed boulder sizes.

1. **Steep-creek law: Ferguson & Recking (2025) calibrated variable-power equation (VPEc, their eq. 19).**

   U\*\* = 1.6 · q\*\*^0.6 · (1 + 0.1 · q\*\*^0.6)^−0.33

   - U\*\* = U / √(g S D84) is the dimensionless velocity.
   - q\*\* = q / √(g S D84³) is the dimensionless unit discharge, with q = U · h (m²/s).
   - U is the mean velocity (m/s), h the mean depth (m), S the slope (m/m) and g = 9.81 m/s².
   - The law was fitted on 2,717 field measurements at slopes 0.009–18% and relative depths h/D84 0.2–183, with 80% of velocities within ±20%. In deep flow it behaves like Manning–Strickler (U/u\* ≈ 7.7 (h/D84)^(1/6)).
   - Citation: Ferguson, R. & Recking, A. (2025), *Water Resources Research* 61, e2024WR038852, doi:10.1029/2024WR038852.
2. **D84 is assumed from slope:** D84 = 0.25 m × (S / 0.10)^0.5. That gives 0.18 m at 5%, 0.25 m at 10%, 0.35 m at 20% and 0.62 m at 61%. No grain sizes were measured on the Preserve.
   - Measured anchors: fish ladders, D84 0.18–0.26 m at 2.6–10% (D'Agostino & Michelini 2015); Rio Cordon, 0.33–0.63 m at 8–21% (Comiti et al. 2007, doi:10.1016/j.jhydrol.2007.03.021); Riedbach, 0.16–0.99 m at 2.8–41% (Schneider et al. 2015, doi:10.1002/2015WR016934).
   - In the law's shallow limit U ∝ S^0.2 D84^−0.4, so the 0.5 exponent makes velocity nearly independent of slope. Comiti (velocity ∝ S^0.01) and the Riedbach measured exactly that.
   - The reference value sits below the alpine sites because coastal sedimentary creeks probably supply finer clasts. That is an inference, not a measurement.
3. **Applied per subsection of the divided channel** (`flow-resistance.ts`, `steep-creek-rating-curve.ts`). At every 2 cm ladder step the main channel and each floodplain (split at the bank tops as in m1) are treated separately, as in the research prototype (`compare-flow-resistance-laws.ts`):
   - The subsection's mean depth h = A/T gives U from VPEc, solved by bisection because q\*\* contains U.
   - That U becomes an effective n = R^(2/3) S^(1/2) / U with the subsection's hydraulic radius R = A/P.
   - The subsection discharge is (1/n) A R^(2/3) S^(1/2), and the three are summed. A dry subsection carries nothing and the law is not evaluated.
4. **Blend from Manning's n by slope** (`STEEP_CREEK_ROUGHNESS_BLEND`). Each subsection is blended toward its own Manning's n (0.04 main channel, 0.07 floodplain):
   - Weight w = 0 at S ≤ 2%, 1 at S ≥ 8%, and ln(S / 0.02) / ln(4) between.
   - ln n = (1 − w) ln n_Manning + w ln max(n_Manning, n_VPEc).
   - The effective n never drops below the Manning value, so the law can only slow water down.
   - At w = 0 the Manning n is used as is, so a segment whose anchor slope is 2% or less gets m3 v2's rating curve value for value. That held on all 3,292 anchors with a rating curve.
   - Depth is continuous across 2% and 8% (no jump). Inside the window, depth at a fixed discharge rises with slope, which matches the plane-bed to step-pool transition near 3% (Montgomery & Buffington 1997).
5. **Slope** is the anchor cross-section's ±30 m least-squares bed slope (m3 v2's, floored at 0.001), used as the friction slope (normal-depth assumption).

What is copied and why:
- `steep-creek-rating-curve.ts` copies the shared `buildRatingCurveRecord`, with n from a function of the subsection geometry and the slope. Editing the shared file would change m1–m3's fingerprints.
- `steep-creek-anchor-section.ts` copies m3's `anchorRating` section cut, because m3's function calls the shared builder directly.
- `steep-creek-time-series.ts` copies m3's Stage 3 orchestration once as a function, because m3's entry point runs on import. m5 uses it too.
- Channel, bed, breaches, stations, anchor placement, junction depths, pool filling and inversion are imported from the m3 folder and listed in `sharedCodeFiles`.
- **Channel guard.** Stage 3 refuses to run unless m3's current code fingerprint equals the saved m3 v2 manifest's. It then records m3 v2 as `channelFromModeledWseVersion`, which is what lets ribbon v2 draw m4.

## Why the depths are reasonable

Results on the Preserve, against m3 v2 (the same channel):

| | m3 v2 | m4 |
| --- | --- | --- |
| 27714697-040…045 at 2023-01-10T01Z: rating depth | 5.5–7.7 cm | 12.4–20.0 cm |
| … velocity | 1.06–2.67 m/s | 0.37–0.58 m/s |
| … Froude | 1.66–3.83 | 0.38–0.54 |
| … effective n | 0.039–0.040 | 0.20–0.32 |
| Slopes 8–15% at the peak: median Froude, share above 1 | 1.89, 100% | 0.97, 49% |
| Slopes 15–30% at the peak | 2.39, 100% | 0.83, 39% |
| Slopes 8–15% at 2019-01-17T13Z (low flow) | 1.64, 100% | 0.47, 6% |

- Steep-reach Froude numbers fall inside the 0.3–0.8 field range, and effective n inside the USFS 0.1–0.3 bankfull range at the peak. The research report's numbers on m3 v1's channel were 12.9–22.3 cm, 0.37–0.55 m/s and Froude 0.38–0.50. The few-cm differences come from m3 v2's anchor sections (the raw lowest point), not the law.
- At the extreme 2023 peak (608 m³/s at the gauge) relative submergence is high and VPEc relaxes toward Manning-like roughness. That is why about 40–50% of steep segments stay above Froude 1 then.

## Known limitations

- **D84 is assumed.** Halving or doubling D84 moves the steep reach's peak depth by about −20% / +17–28% (research report). A few pebble counts or scaled photos at 3–4 steep reaches would be the cheapest calibration.
- **Extrapolation beyond the data's slopes.** VPEc's data stop at 18% (Rickenmann & Recking's at 24%); the Preserve's anchors reach 62%. Only Rickenmann 1994 (an unverified conference paper) and the Riedbach (41%) go that far, and both support roughly slope-independent velocity, which m4 reproduces.
- **Low-flow submergence.** At typical winter low flow on steep creeks, h/D84 is about 0.1–0.2, at or below the 0.2 floor of the VPEc data. The effective n there reaches 0.5–0.86 on 27714697-040…045 at 2019-01-17T13Z (Froude 0.12–0.17), beyond the published bankfull range. Treat low-flow steep depths (3.5–6 cm) as an extrapolation.
- **Reach-averaged law on one section.** The laws describe reach averages, but here they are applied to one anchor cross-section (a pool or a step) with a ±30 m slope. The ±100 m junction smoothing helps.
- **What the law leaves out:** wood, bedrock steps and vegetation. All of these push real depths deeper (Yochum 2012).
- **Moderate slopes stay fast at the extreme peak.** At 2–8%, 75% of segments are still above Froude 1 at the January 2023 peak (96% in m3 v2). Starting the blend lower would touch more of the flat network.
- **Floodplain n.** The floodplains keep base 0.07 with the same blend. That is a modelling choice.
- **Flat creeks are not untouched in the Time Series.** A segment whose own anchor slope is 2% or less gets m3 v2's rating curve value for value. Its junction depths, though, are m3's length-weighted mean of the wet anchor depths within ±100 m, which can include steeper neighbours. Its smoothed pool-filled surface can also reach across a shared station.
  - Over all hours, 265 of 650 flat segments stay within 1 mm of m3 v2 and 385 move more than 1 mm at some hour (384 through a junction depth). 8.4% of their values differ by more than 1 mm.
  - At the peak: 81 move more than 1 mm, 26 more than 1 cm, and the largest move is 0.118 m.
  - The Jalama gauge segment 27714637-026 is unchanged at the peak and at 2019-01-17T13Z, and moves +2 mm at 2018-03-22T17Z.
- **Ribbon ceiling.** The same 42 hourly values on 15 deep segments of 27714639 (8.3–11.9 m) lie above ribbon v2's 8 m top rung, as in m3 v2. m4 adds none.

## Results (dangermond-preserve, v1)

- 3,338 Creek Segments. 650 anchor ratings use Manning only (slope ≤ 2%), 1,723 are blended and 919 use VPEc only (slope ≥ 8%). 43 segments lie wholly on a breach and are null, as in m3 v2.
- 83 hourly values are clamped at the rating curve's top.
- Chart = drawing on ribbon v2 within 0.5 mm on every wet segment at 2023-01-09T12Z, 10T01Z, 14T12Z and 2019-01-17T13Z (11,907 segment-hours). No station is drawn below its bed, and every drawn boundary pair is identical.
- No negative depth among 155,522,374 values. Beds are identical to m3 v2's in every file.
- 27714697-044 at the peak: WSE 249.213 m (m3 v2: 249.111 m), depth at the anchor 0.171 m. The water drawn at the anchor is 0.052 m above the browser terrain; m3 v2's was 0.050 m below it.
- Output: 2.0 GB of Time Series in 736 files; the largest file is 15.0 MB (27715677/WY2022). Stage 3 takes 197 s.

## Version history

| Version | Change |
| --- | --- |
| 1 | New method: m3 v2 with the Ferguson & Recking (2025) VPEc flow resistance, D84 = 0.25 m × (S/0.10)^0.5, blended from Manning's n over 2–8% slope, on m3 v2's channel. |
