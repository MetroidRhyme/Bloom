---
name: bloom-range
description: Use when touching Bloom's plantable-range highlight or grass rendering - anything involving the light-green highlight around the player, the "control area", the grass wash/tufts, renderGridMesh, rangeArea, liveControl, inRange, state.todayAccessible, or "where can I plant/water/harvest". Also use BEFORE changing anything in the MEADOW TUFTS section or grassPatternMarkup/drawGrassTufts, since this exact subsystem has been the site of ten straight version bumps (v2.39.0-v2.39.9) of real regressions - a scope mismatch between what's highlighted and what's actually interactable, and a silent per-cell pixel-anchor bug - both shipped and had to be fixed twice. Explains the three pieces that must stay in sync (the live rangeArea polygon, the wider renderGridMesh ambient wash, and the inRange()/liveControl() gameplay gates), the tuft anchor invariant that caused a real shipped bug, and the day-rollover staleness trap.
---

# Bloom's plantable-range highlight and grass

This is the light-green area around the player marking where
plant/water/harvest/sell/fertilize/pick/sprinkler actually work, textured
with a "Meadow Tufts" grass pattern. It looks like one simple thing on
screen. It is actually three separate pieces of code that have to agree
with each other, and every real bug in this system so far has been one of
those pieces quietly drifting out of sync with the other two - never a
typo, never a crash, always a silently wrong picture. Read this before
touching any of it.

## The three pieces

1. **The gameplay gate.** `inRange(q, r)` (search for its definition) is
   the one check every plant/water/harvest/sell/fertilize/pick/sprinkler
   action actually goes through. It's true if `liveControl(q, r, now)` is
   true (live PLANT_RANGE around the player's current GPS position, or a
   currently active Scry/Loki extension) OR if `(q, r)` was in range at
   any point earlier today (`state.todayAccessible`, re-verified against
   `localDayKey()` on every call so a stale pre-midnight set is never
   mistaken for today's). This is the ONE source of truth for "can the
   player act here right now" - never duplicate this logic, always call
   `inRange()`.

2. **The live highlight.** `rangeArea` (search `onLocationUpdate`) is a
   single `L.polygon` covering exactly the live PLANT_RANGE square around
   the player's current tile (`cellRingLatLngs(q, r, PLANT_RANGE)`),
   re-shaped with `animateRangeTo` whenever the player crosses into a new
   tile. It's filled with an SVG `<pattern>` (`grassPatternMarkup` /
   `ensureGrassPattern`, in the GPS section) instead of a flat color -
   four tufts per real grid square, phase-anchored to the map's world
   pixel grid so it doesn't visibly reshuffle on zoom (see the "anchor the
   walking-range grass pattern to the world pixel grid" comment on
   `ensureGrassPattern`).

3. **The ambient wash.** `renderGridMesh` (a canvas layer, not a Leaflet
   vector layer) paints a lighter grass wash + tufts across every tile in
   the *current viewport* that passes `inRange()` - not just the live
   square rangeArea covers, but everywhere else the player has walked in
   range of today too. This is what makes the walked-and-remembered area
   visibly read as "yours" the same way the live square does, without
   requiring the player to still be standing there. It repaints on pan/
   zoom/viewreset/resize automatically (`map.on('moveend zoomend viewreset
   resize', scheduleGridRedraw)`), but it is a persistent buffer - nothing
   clears or repaints it just because `state.todayAccessible` or
   `state.lokiAccess` changed elsewhere. Anything that mutates either of
   those (`markAccessible`/`markAccessibleToday`, a Loki grant expiring,
   the offline-catch-up handler on tab resume) has to call
   `scheduleGridRedraw()` itself, or the canvas silently keeps showing
   stale grass - see the "fix stale grass after a day rollover while
   backgrounded" fix (v2.39.5) for exactly this failure mode, and make
   sure any new mutation site follows the same pattern.

**The rule that ties them together: renderGridMesh must gate on
`inRange()`, never on `liveControl()` alone.** It was scoped down to
`liveControl()` once (v2.39.7), on the theory that showing grass over the
wider today's-walk memory was misleading players about what they could
act on. That reasoning doesn't actually hold - `inRange()` already
re-checks `localDayKey()` on every call, so gating grass on it can never
show grass somewhere real access has expired - and it was reverted back to
the wider `inRange()` scope in v2.39.9 once a player pointed out the
"memory" of their walk had visibly stopped working. If a future request
sounds like "grass shouldn't show where I can't act," the fix is almost
certainly NOT narrowing the paint gate again - check whether the real bug
is the anchor invariant below first, since that produces the exact same
symptom (grass outside where you can act) with a much narrower, more
correct fix.

## The tuft anchor invariant (a real shipped bug, fixed in v2.39.8)

`GRASS_TUFT_SPOTS` (in the MEADOW TUFTS section) authors each tuft's
position as a **top-left-origin fraction of one tile** - `x: 0.22, y: 0.30`
means 22% in from the left edge, 30% down from the top edge. Both
`grassPatternMarkup` (SVG, self-contained per pattern tile) and
`drawGrassTufts` (canvas, called from `renderGridMesh`) place tufts by
adding `spot.x * tileW` / `spot.y * tileW` on top of an anchor point. For
that math to land inside the tile it was computed for, **the anchor must
be that tile's own top-left corner - the smaller x-pixel (west) and the
smaller y-pixel (north) edge** - never the bottom or right edge.

`renderGridMesh`'s per-row/per-column pixel arrays (`xs`, `ys`) are built
so that for row index `aj`, `ys[aj]` is the SOUTH/bottom edge (larger
y-pixel) and `ys[aj + 1]` is the NORTH/top edge (smaller y-pixel) - this is
the same convention the wash `fillRect` calls use, which is exactly what
makes the bug easy to introduce by accident: `fillRect(xs[ai], ys[aj], ...,
ys[aj+1]-ys[aj])` is *correct* using the bottom edge (fillRect walks
backward via a negative height), so it looks natural to reuse `ys[aj]` for
the tuft anchor right next to it - but the tuft math walks *forward* (adds
a positive fraction), so it needs the opposite edge, `ys[aj + 1]`.

Getting this backward doesn't crash and doesn't look obviously wrong: every
tuft lands up to a full tile-height further south than its own cell, but
since a normal grid has a cell below to absorb the displaced tuft, nearly
the whole grid still looks fully covered. The only place it becomes
visible is the southmost row of whatever's currently painted, where the
displaced tufts have no cell below to land in and print as a stray
sliver of grass outside the highlighted/painted area entirely - which
reads exactly like a scope bug ("grass where I can't act"), not a pixel
bug, and is easy to mis-diagnose as one (this is likely what actually
happened in the v2.39.7 mis-fix described above).

**Before shipping any change to `drawGrassTufts`, `grassPatternMarkup`, or
the `xs`/`ys` construction in `renderGridMesh`, re-run (or extend) the two
regression sections that exist specifically to catch this class of bug:**
- `"grid mesh grass tracks the whole day's walk, resets at midnight"` -
  confirms painted area matches `inRange()` exactly, including the
  day-rollover reset.
- `"grass tufts do not bleed past the live-control boundary"` - samples
  the pixel alpha of the tile just past the live-range edge and asserts
  it's unpainted; this is the one that would have caught the v2.39.8 bug
  directly (it fails with a nonzero alpha on the pre-fix build).

Both live in `tests/regression.js`; see the `bloom-playtest` skill for the
harness mechanics (`cellPaintedAlpha`, the layer-point-to-canvas-buffer
pixel read) if extending them - and see that skill's own gotcha section
before writing a new fixed-tile-offset check like these, since a leftover
zoom level from an earlier test section can make one fail for a reason
that has nothing to do with grass at all.

## Shared visual data, two renderers

`GRASS_TUFT_SPOTS`, `GRASS_BLADE_OFFSETS`, `GRASS_WASH`/
`GRASS_WASH_OPACITY`, `GRASS_TUFT_SCALE`/`GRASS_TUFT_OPACITY`, and
`GRASS_UNIT_PER_TILE` (all in the MEADOW TUFTS section) are the single
source of truth for how a tuft looks, shared by both renderers so they
read as the same grass at the same zoom. If you change the shape/color/
density, both `grassPatternMarkup` (SVG, live rangeArea square) and
`drawGrassTufts` (canvas, wider ambient wash) need to keep drawing from
these same constants rather than drift into two different-looking
textures - that's the whole reason the constants were pulled out and
shared in the first place (see the "MEADOW TUFTS" section banner comment).
