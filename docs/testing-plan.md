> [!IMPORTANT]
> **Historical exploratory guidance.** This document is earlier SceneView (Esri’s 3D map view) testing guidance. Current test governance is the repository-root [TESTING.md](../TESTING.md) and the [test catalog](../tests/support/catalog/catalog.json). When architecture or behavior conflicts, the October 9 Linear UCS-246 [Creek Water Visualization System Design](https://linear.app/ucsb-spatial-center/document/creek-water-visualization-system-design-593ddc502c13) is authoritative.

# Creek water visualization — testing plan

Slight tuck under the terrain is OK. Water in a dry side channel is not. No screenshot pixel-matching.

Wait for `goTo` to finish and the layer to stop `updating`. Don’t `sleep(3000)`.

---

## The tests

Each row: what we run, what a pass means, what a fail usually is.

| Test | What it tells you | Confidence |
|---|---|---|
| **In the list, right place** — golden creek id is in `layer.graphics`; its box still overlaps that lon/lat; Z matches expected WSE | We didn’t delete it, move it, or flatten it | High that the *data* is still that creek. Not a picture. |
| **Pickable if you zoomed there** — `goTo` that spot → wait idle → `hitTest` hits that graphic | If you pointed at that creek, SceneView would treat it as there | High that it’s in the live view at that spot. Closest we get to “I’d see it if I zoomed in” without a screenshot. |
| **View isn’t dying** — `fatalError` is null; SceneView `usedMemory / totalMemory` under ~70% | We didn’t crash WebGL or pin Esri’s memory budget | High the 3D view is still healthy. This budget is **not** your 32 GB RAM. |
| **Machine warning (don’t fail)** — log chip / RAM / `qualityProfile` / memory % | “Passed on this box; a weaker GPU may struggle” | Info only. Your M2 Max is a poor stand-in for a cheap laptop. |
| **Shape / stage (tiny fake reach)** — no stairs at joins; WSE goes downhill; +1 ft lifts Z ~0.3048 m; width grows; no overlap with `forbiddenDry` | The ribbon math still matches the plan | High for geometry bugs. Fast. No SceneView required. |

**Not doing:** pixel-diff screenshots, click tours of the whole Preserve, `layer.graphics.length === N` as proof that N things *drew*.

**`forbiddenDry`:** In the tiny fake reach we draw a polygon next to the creek that means “dry side channel — water must not go here.” The test fails if the water ribbon overlaps that polygon. That’s the bleed bug.

**`fatalError` vs WebGL vs SceneView:** SceneView is Esri’s 3D map (camera, layers, water). It draws using **WebGL** (the browser’s GPU API). If WebGL dies, SceneView sets **`fatalError`** — the 3D canvas is sick (black/blank), even if `layer.graphics` still has objects. `fatalError` is null = GPU session is still alive. Memory % is a different check: alive, but the *closet* may still be filling up.

---

## Anti-whack-a-mole pack

Keep a **golden list** of creeks you care about (id, lon/lat, expected Z). After any change — new segments, +10,000 pieces, a “quick fix”:

1. Every golden id is still in the list  
2. Each is still in the right place (box + Z)  
3. `goTo` → idle → **hitTest hits that graphic**  
4. No `fatalError`; SceneView memory % isn’t against the wall  
5. **Warn** (don’t fail): machine + `qualityProfile` + memory %

That’s “the old creek is still there, in the right spot, and if I zoomed in the viewer would pick it.” Not 200 unit tests.

**How hitTest works:** It is **not** “is this lon/lat in the dataset?” It shoots a **ray from the camera through an XY pixel** on the SceneView canvas (same as a click). You usually: `goTo` the creek → `view.toScreen(mapPoint)` → `hitTest(screenPoint)`.

A **wall in front of a cube:** the ray hits the wall first. The cube may still appear **later** in `results` (near-to-far). If you only check `results[0]`, you get the wall — test “fails” even though the cube exists. If you `include: [cubeLayer]`, Esri can **skip** the wall and still hit the cube, so that’s **not** a visibility test.

For our pack: look at the creek (not from behind a ridge), then confirm **our water graphic** is in the hit list — not merely “something” at `results[0]`.

---

## Low / medium / high

Run the pack at Esri’s three `qualityProfile`s. They change the SceneView closet size (medium ~750 MB, high ~1500 MB, low smaller — phones).

| Profile | What a result means |
|---|---|
| **medium** | **The bar.** Pack passes here → we’re good to go for a normal laptop/desktop. |
| **high** | Nice-to-have. Your M2 Max will often live here. Don’t treat this as the ship gate. |
| **low** | **Mobile / weak GPU preview.** Failures here don’t block desktop. **Keep the history** — “low failed: fatalError / memory / hitTest miss on Escondido.” That’s the “if you want this on a phone, here’s what you’ll hit” note. |

Store a small log per run: date, profile, pass/fail, memory %, which golden failed. You’re not failing CI on low unless we decide to support phones. You’re collecting the story.

**Don’t treat 750 / 1500 as laptop RAM buckets.** Those are how much Esri lets **this SceneView** use at that profile. An 8 GB laptop and a 32 GB Mac both get ~750 MB on **medium**. `high` is ~1500 MB *if you turn it on* — only machines that can actually feed WebGL that much will be happy.

| Profile | Typical hardware that is fine | Typically struggles |
|---|---|---|
| **low** | iPhone / small Android (Esri’s default there) | — this *is* the weak-device mode |
| **medium** | Normal laptop/desktop, 8–16 GB, integrated GPU | Many open tabs, cheap Chromebook, very old iGPU |
| **high** | M-series Mac, discrete GPU desktop | 8 GB + weak iGPU; Esri says don’t force high unless you know the device |

Ship gate stays **medium**. If `usedMemory` is near 750 MB *on medium*, the **view closet is full** — not “you need a 16 GB machine.” Scale data down, or accept chunkier terrain. If you only pass when forced to **high**, you’re saying “needs a stronger GPU,” and you should write that down.

---

## When the test and your eyes disagree

**hitTest says the graphic is there, but you don’t see water on the website.**  
Can it happen? **Yes.** Uncommon, not mythical.

| Likely meaning | What to do |
|---|---|
| You’re looking at the wrong place / wrong zoom / wrong stage | Check camera and slider |
| Water is there but **hard to see** — tucked under the bank (often OK), tint too like the basemap, very thin ribbon | Eyes: lighting/symbol, not a missing graphic |
| Terrain or imagery hasn’t finished | Wait until the layer isn’t `updating` |
| Symbol/elevation mode is weird (exists, pickable, looks wrong) | Check `absolute-height` + water symbol |

The test is still useful: **the creek didn’t vanish from the scene.** Your eyes are answering a different question: **does it look like water?**

**hitTest misses, but the list has it, and you’re looking right at it.**  
Rarer. Means “inventory yes, pickable no.” Check `fatalError` and memory first. If those are fine, that’s a real wiring/draw bug — the interesting one.

**List has 10,000, you don’t see 10,000.**  
The list is inventory, not a GPU roll call. GraphicsLayer usually does **not** quietly hide extras. Overload looks like hitching, chunky terrain, memory against the cap, or `fatalError` — not a silent “we hid 4,000 creeks.” Off-camera is normal (behind you = not drawn).

---

## How AI should write these / how you review

```
given golden creek (or tiny-reach.json)
when  load / setStage / goTo
then  one check from the table
```

Review the **title** and the **one check**. If a fail wouldn’t be a viz bug you care about, delete it.

- Good: “Escondido golden still hitTest-able after adding 10k segments”
- Bad: “computes perpendicular unit normal”

---

## What “memory” means (not your 32 GB)

`usedMemory` / `totalMemory` is **SceneView’s own 3D budget**, in bytes. Not Chrome. Not system RAM.

Esri’s documented caps (from their memory sample):

- **medium** `qualityProfile` → about **750 MB**
- **high** → about **1500 MB**

When `usedMemory` gets close to `totalMemory`, Esri **lowers quality on purpose** (chunkier terrain, fewer features on FeatureLayers) so the tab is less likely to crash.

Your Mac’s 32 GB is the house. Chrome gets some rooms. This 3D view only takes **one closet Esri sized** (~0.75–1.5 GB). A cheap laptop uses the same closet math — it just hits the wall sooner.

**Practice:** stay under ~**70%** of `totalMemory` **at medium**. Log all three profiles. Don’t fail the ship gate because **high** is pretty or **low** is a phone.

---

## Glossary

| Term | Meaning |
|---|---|
| **SceneView** | ArcGIS 3D map. |
| **Graphic** | One water polygon on the map. |
| **`layer.graphics`** | JS list of graphics we created. Inventory, not “GPU drew these.” |
| **hitTest** | “If I pointed here, what graphic would I hit?” One spot, not a census. |
| **WSE** | Water-surface elevation (NAVD88). The Z we want. |
| **`fatalError`** | WebGL/GPU context is gone. Whole view is sick. |
| **`performanceInfo`** | SceneView’s own memory budget (`usedMemory` / `totalMemory`). Not system RAM. |
| **`qualityProfile`** | Esri’s low/medium/high 3D quality. Weaker machines get less. |
| **Golden list** | The few real creeks we always re-check so vibe-coding doesn’t play whack-a-mole. |
| **Fixture** | Tiny fake reach file for shape/stage tests. |
