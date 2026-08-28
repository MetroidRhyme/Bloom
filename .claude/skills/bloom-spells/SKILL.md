---
name: bloom-spells
description: Use when the user wants to add, modify, or reason about one of Bloom's "basic elemental magic" spells (planting-formation mechanics like the RAIN RING, GROW SPELL, LOKI'S CONTROL, SCRY) or asks for a new one - including changing a rune's own look, timing, or tap-to-inspect/no-planting behavior. Explains the existing spell architecture in index.html - the consuming-vs-persistent design fork, the shared CORNER ZONES foundation, the shared Runes foundation (glyph conventions, the zoom-rescale gotcha, the rune-ground-is-unplantable pattern), the tier system, and the checklist for wiring in a new tier-gated formation spell - so a new spell reuses existing machinery instead of re-deriving it from scratch.
---

# Bloom's spell system

Bloom has a growing family of "basic elemental magic" - mechanics triggered
by planting flowers in a specific formation, layered entirely on top of the
core plant/water/harvest loop. All of it lives inside `index.html`'s one
inline `<script>`, no separate files. Four exist as of this writing, in
build order: RAIN RING, GROW SPELL, LOKI'S CONTROL, SCRY. Read the
in-code comments at each constant/section banner (search the names below)
before changing anything - this skill is an index and a design guide, not a
replacement for the comments.

## The one decision that shapes everything else: does the spell CONSUME the flowers?

This is the first question to answer for any new spell, because it decides
which of the two existing hook patterns to copy.

**Persistent (RAIN RING, LOKI'S CONTROL, SCRY):** the flowers stay planted.
The spell's structure is "complete" for as long as the flowers are there
and grown, and "active" only while none of them is wilted - watering
upkeep is the whole cost. Detection can be hooked **directly inside
`applyWatering`'s own MAX_STAGE-reached branch** (right next to the
existing `colorOfPlant(p) === RAIN_RING_COLOR` check), because nothing
here ever deletes a plant - it's safe even when `applyWatering` runs inside
`catchUpSprinklersOffline`'s batch replay loop.

**Consuming (GROW SPELL):** the flowers are deleted the instant the
formation completes. This is NOT safe to hook inside `applyWatering`
itself - `catchUpSprinklersOffline` replays multiple plants' growth in one
synchronous loop, and deleting a plant that a later loop iteration still
holds a reference to hands that iteration a stale/undefined `p`, crashing
it. Instead, a consuming spell's check is called from **every call site
that invokes `applyWatering`** (`waterPlant`, `finishAutoWatering`, and
`catchUpSprinklersOffline` - the last one only *after* its own loop has
fully finished, never from inside it), each time guarded on
`res.grew && p.stage >= MAX_STAGE`. See `checkGrowBlocksAround`'s own
comment for the full reasoning. A consuming spell also needs a one-time
boot sweep (`sweepGrowBlocksFull`, called from INIT) for a save that
already has a complete-but-never-consumed formation sitting in it from
before the feature existed - the persistent spells need this too
(`recomputeLokiZonesFull`/`recomputeScryZonesFull`/`recomputeRainRingsFull`),
just without the consuming side effect.

Consuming doesn't mean "and then nothing's left" - GROW SPELL's own
formation is destroyed, but `resolveGrowBlock` leaves a **rune** behind at
that same spot (a timed, 4x-growth zone). Consuming vs. persistent decides
how the *formation itself* is detected; a rune is a separate concern layered
on top - see the Runes section below, which RAIN RING's own rune (a
persistent-spell rune, triggered by watering rather than by consuming
anything) also belongs to.

## The tier system

Every color in the `COLORS` array carries a breeding `tier` (0 = the four
base colors, 1 = six colors one cross deep, 2 = three colors two crosses
deep, 3 = Gold plus the species-locked signature colors). `colorFor(id).tier`
reads it; `colorOfPlant(p)` resolves a plant's color id first. Formation
spells gate on tier via `colorFor(colorOfPlant(p)).tier === SOME_TIER`.
Claimed so far: **GROW_TIER = 1** and **LOKI_TIER = 1** (same value,
separate constants - see the interaction note below), **SCRY_TIER = 2**.
Tier 3 (Gold/signatures) is not yet claimed by any spell - the natural next
step up, and the only tier where every flower is itself already a
significant investment to grow.

**Cross-spell interaction to know about:** GROW_TIER and LOKI_TIER are both
1, so a 2x2 block could in principle satisfy both spells at once - and once
did. It cannot any more: since v2.40.0 the two recipes are mutually
exclusive *by construction*. `growBlockAt` requires exactly one shared
color across four DIFFERENT species; `isCornerBlockOfTier` requires at
least two different colors in the block. No block can be both, so the grow
spell can no longer eat a completed Loki corner out from under it - which
is what used to happen: it fired the instant such a block completed,
consuming it before the zone referencing that tile could register. The
CORNER ZONES banner comment in `index.html` says the same thing; keep the
two in step if either rule is ever retuned.

If you add a new formation spell on an already-claimed tier, that is the
risk you inherit: work out whether its recipe can overlap the existing
one's, and if it can, make the two exclusive by construction the way these
now are rather than relying on which detection hook happens to run first.

## The CORNER ZONES foundation (shared by LOKI'S CONTROL and SCRY)

Both spells use the same shape - four 2x2 corner blocks of one tier at the
corners of a rectangle between `ZONE_MIN_SPAN` and `ZONE_MAX_SPAN` tiles on
a side - so the detection/rendering is genuinely shared, not copy-pasted.
Search `CORNER ZONES` for the section banner. The reusable pieces:

- `isCornerBlockOfTier(q, r, tier)` - is the 2x2 anchored at (q,r) a
  complete, grown, single-tier block with **at least two different colors**
  in it? Species are free to repeat; only color diversity is required. That
  "never monochrome" rule arrived in v2.40.0 and is half of what makes a
  corner block and a grow-spell block mutually exclusive (see the tier
  section above) - not merely a nicety.
- `isZoneValidOfTier(qMin, rMin, qMax, rMax, tier)` - is this whole
  rectangle a valid zone (span limits + all four corners valid)?
- `newZonesFromAnchorOfTier(aq, ar, tier)` - every rectangle this one
  corner block completing could have just formed, across every legal
  size/role combination. This is the expensive-looking but actually-cheap
  (a few thousand O(1) checks, run only on a watering/harvest event) part
  that makes a non-fixed-size formation tractable to detect incrementally.
- `refreshZoneRegistry(registry, q, r, tier)` - adds/removes entries in a
  given registry (add new completions, drop anything broken) around a
  changed tile. Returns whether anything changed.
- `recomputeZoneRegistryOfTier(tier)` - full rebuild, for the boot sweep.
- `isZoneActive(z, now)` / `isInActiveZoneOf(registry, q, r, now)` - the
  wilt check (none of the 16 corner flowers over `WATER_DURATION_MS` since
  last watered) and the "is this tile covered right now" query.
- `zoneLatLngs(z)` / `renderZoneRegistry(registry, layers, styleFor, onTransition)` -
  the shared boundary-rectangle Leaflet rendering, with per-spell color/
  style and an `onTransition(active)` callback. Per the toast convention
  below, `onTransition` only toasts the `!active` (lapsed) case - becoming
  active is silent, the boundary rendering itself is the confirmation.

A new tier-based rectangle-corner spell is almost entirely boilerplate on
top of this foundation - see `lokiZones`/`scryZones` and their thin
wrapper functions (`refreshLokiZoneCandidates`, `recomputeLokiZonesFull`,
`isInActiveLokiZone`, `lokiZoneStyle`, `renderLokiZones`, and the Scry
equivalents) immediately below the CORNER ZONES section for the ~10-line
pattern to copy: a registry var, three one-line wrapper functions, a style
function, and a render function. The *effect* (what being "in an active
zone" actually does) is always spell-specific and lives outside this
section - Loki's is in `markTileControl`/`inRange` (extends
`state.lokiAccess` timestamps), Scry's is a single unconditional check
added to `inRange` directly, with no persisted state at all.

## Runes: a timed object a spell leaves behind (shared by RAIN RING and GROW SPELL)

A rune is the *effect*, not the formation - what's left after (RAIN RING)
watering a structurally-complete ring's own empty center tile, or (GROW
SPELL) a consuming formation resolving. Unlike a CORNER ZONE, whose
"structure" is always re-derivable from `state.plants` (the corner flowers
stay planted), a rune's own timing has nowhere else to come from - GROW
SPELL deletes the flowers that triggered it, and RAIN RING's watering is a
one-off action with no other record. **A rune's "when did this last
activate / how long is left" always needs its own persisted timestamp** -
`state.runeWater` (rain, keyed by the ring's center tile) / `state.growRunes`
(grow, keyed by the block's own top-left anchor), each entry just
`{ activatedAt }` or similar. Re-triggering an already-active rune (watering
the rain rune again, or a new grow spell resolving on the exact spot before
the old rune there expires) **tops the timer back up rather than
stacking** - copy `activateRainRune`'s/`resolveGrowBlock`'s own overwrite,
don't add a counter.

A new rune (or a change to one of these two) touches several places that
don't share one obvious "the rune section" - easy to fix in one spot and
forget the others, which is exactly what happened building the grow rune:

- **The glyph**: `buildRainRuneSVG`/`buildGrowRuneSVG` share one visual
  language - a 120x120 viewBox centered on (60,60), an outer glow circle,
  an N-point compass star built from N/4 squares each rotated 360/N degrees
  apart (`runeSquarePoints`/`polarPoint` - rain uses 2 squares for 8
  points, grow uses 4 for 16), 16 rim tick marks, 8 star-point diamonds, a
  dashed inner circle, and a center icon unique to that spell (rain: a
  raindrop; grow: a 3-petal budding flower via `budPetal`'s per-instance
  `<g transform>`). A new rune doesn't have to match every count, but keep
  the same *pieces* so it reads as the same family, not an unrelated icon.
- **The large-scale boundary**: `rainBoundaryGeometry`/
  `growRuneBoundaryGeometry` redraw the *same* glyph at real lat/lng scale
  around the rune's actual reach, so the small marker and the big area
  visibly agree. Rain's reach is genuinely circular, so its boundary is a
  circle; grow's reach is Chebyshev-square (`growRuneSpeedupActiveAt`), so
  its boundary is a literal square - **match the boundary shape to the
  actual detection math, don't copy the previous rune's geometry
  wholesale.** Skip an interior tile-by-tile lattice unless the boundary is
  small (rain's `RAIN_RING_RADIUS`) - at `GROW_PULSE_RADIUS`'s 21x21-tile
  span it read as a second, mismatched grid on top of the map's own mesh
  and had to be removed after a player reported it directly.
- **Live zoom rescale - the one genuinely nasty gotcha**: any marker built
  via a `plantIconBase()`-sized `L.divIcon` (a rune's marker included) MUST
  be rebuilt inside `scheduleMarkerRender()`'s batch (search
  `renderPlants(); renderWild(); ... renderGrowRunes();`), not on its own
  separate schedule (cast-time/tick/boot only). Every render call in that
  batch writes the SAME shared `_iconBuiltPx`, which
  `rescalePlantIcons()`'s live in-gesture CSS transform (bound to the
  `zoom` event) reads as the baseline for every marker type uniformly. A
  marker type left out of the batch still gets that live transform applied
  to it, against a baseline some *other* marker type just moved - not its
  own actual last-built size - so it visibly drifts to the wrong size with
  every further zoom step. This shipped for real (the grow rune was left
  out) and looked like "random sizes when zooming" with nothing obviously
  wrong in the diff that caused it - trace any zoom-size bug straight to
  this list before looking anywhere else. See the `bloom-playtest` skill's
  own gotcha for how to actually test this.
- **The rune's render function must be viewport-virtualized, and the order
  inside it matters.** A rune is not one layer - the rain rune is *seven*
  (glyph, tile lattice, circle, two stars, ticks, diamonds), all real lat/lng
  geometry that Leaflet reprojects on every zoom. Left unvirtualized, every
  rune the player has ever made stays alive forever anywhere on Earth, and
  zoom cost grows with the lifetime rune count instead of with what is on
  screen. Copy `renderRainRings`/`renderGrowRunes`: build only entries passing
  `boxInMarkerViewport(vc, q, r, <the rune's own half-span in tiles>)` and let
  the existing `seen`-sweep tear the rest down. Test the box against the
  rune's *boundary* extent, not its center tile - a grow rune spans
  `GROW_PULSE_RADIUS` tiles either way, so its ring can fill the screen while
  its center sits well off it. Two ordering rules inside the function: any
  state bookkeeping (the grow rune's own expiry prune) runs **before** the
  viewport check, or off-screen runes never expire and pile up in the save;
  and `_iconBuiltPx` is written **before** it too, unconditionally, or the
  zoom-rescale gotcha above comes straight back on a pass where nothing was in
  view. See the `bloom-perf` skill for the wider picture.
- **Rune ground is never a valid plant target, from every path a seed can
  land through**: `runeAt(q, r)` (returns `{ kind: 'rain'|'grow', key }`)
  is the one shared lookup - `rainRings[key]` directly for rain's single
  center tile, `growRuneAt(q, r)` (checking every `growAnchorsAround(q, r)`
  anchor, since a grow rune's registry key is only its own top-left corner
  but its footprint is all 4 tiles) for grow's 2x2. It has to be checked in
  **four independent call sites**, not one: `map.on('click')` (bare tap),
  `resolveSeedTap` (an equipped seed's tap - this one had NO rune awareness
  at all for either spell until it was added, meaning a seed could silently
  plant through and break an intact rain rune with a single tap, years
  after the rain rune shipped), `applyRangeSeedAction` (a dragged
  multi-tile sweep - already had its own rain-only check from a past fix,
  easy to assume that covered every path when it didn't), and `cellFree`
  (the free-ground test `breedSpotFor` picks a bred seedling's tile from).
  That last one is the trap: think "every path a SEED can land through" and
  you will miss it, because breeding spends no seed - it is a *plant*
  landing, not a seed being planted - and it was the last of the four to be
  fixed, in v2.43.2. `breedSpotFor`'s fallback pool is every neighbour of
  either parent, so a cross beside a finished rain ring dropped its seedling
  straight onto the rune's center tile and destroyed the ring. Ask a new
  spell "what are all the ways a plant object can come into existence on a
  tile", not "where can the player plant". `openRunePanel`
  (also kind-dispatching, to `openRainRunePanel`/`openGrowRunePanel`) is
  the matching info-panel half - wire both from the same `runeAt` call so a
  tile that can't be planted on always explains why instead of silently
  refusing.

## Wiring checklist for a new formation spell

1. Decide consuming vs. persistent (above) - this decides where detection
   gets hooked.
2. Add constants near the existing spell constants (search `RUNE_ACTIVE_MS`
   for the block they live in) - tier, any span/radius/duration numbers,
   with a comment explaining the mechanic in full (these comments are the
   actual spec; write them before or while writing the code, not after).
3. If it's a corner-zone shape: add a registry var + the five wrapper
   functions per the pattern above. If it's a new shape entirely: it needs
   its own detection functions, but the consuming-vs-persistent hook
   placement rules and the boot-sweep requirement still apply.
4. Hook detection into every place the relevant plant state can change:
   `applyWatering`'s flourish branch (persistent spells) or every
   `applyWatering` call site (consuming spells), plus `harvestPlant` (a
   harvested tile can break a formation), plus any other spell's own
   consumption if tiers could overlap (see resolveGrowBlock's calls to
   `refreshLokiZoneCandidates`).
5. Add the boot-time full sweep/recompute call to INIT, in the same
   cluster as `recomputeRainRingsFull()`/`recomputeLokiZonesFull()`.
6. If the effect depends on wilt state (i.e. anything using
   `isZoneActive`), add a render/recheck call to `tickPlants()` too - wilt
   can flip from the clock alone with no watering/harvest event to hang a
   check on.
7. Wire the actual effect wherever it belongs (`inRange`, a new stat, a
   pulse over nearby plants - whatever the spell does) - keep this
   separate from the detection/registry code, same as Loki/Scry do.
8. State: does the effect need anything persisted (a timestamp, a counter)?
   If so it needs a slot in the default state object, a migration-branch
   fallback (`parsed.newField || {}`), and a line in `saveState()` - follow
   the `lokiAccess` pattern exactly (see loadState's migration branch and
   its own comment). A pure real-time check against a registry (like Scry)
   needs none of this. If the spell leaves a **rune** behind (see the Runes
   section above), its own persisted timestamp is this same requirement -
   follow `state.growRunes`/`state.runeWater` instead of `lokiAccess`.
9. If the spell renders any new marker icon via a `plantIconBase()`-sized
   `L.divIcon`, register its render function in `scheduleMarkerRender()`'s
   batch - see the Runes section's zoom-rescale gotcha for what goes wrong
   if you don't (a real bug, not a hypothetical one).
10. If a seed should never be plantable on ground the spell occupies (a
    rune's own tile(s), most likely - ordinary zone corner flowers don't
    need this, they already occupy `state.plants`), extend `runeAt`/
    `openRunePanel` rather than adding a fourth parallel check - see the
    Runes section's "four independent call sites" note.
11. Test via the `bloom-playtest` skill - and specifically its own gotcha
    about routing growth through `waterPlant()` rather than raw
    `applyWatering()` when the test needs to exercise a call-site-hooked
    (consuming) spell's trigger.
12. Ship via the `bloom-ship` skill - version bump, changelog entry written
    for a player (what the spell does, not the registry/tier mechanism
    behind it), the works.

## Design conventions worth keeping

- **`toast()` is reserved for errors/problems, not status news.** A spell
  casting, activating, or completing successfully is never worth a toast -
  the rune appearing, the zone's boundary rendering, or the marker's own
  state change is the confirmation. Only toast the case that blocks the
  player or reports something gone wrong (e.g. `renderLokiZones`/
  `renderScryZones` toast the corner-wilted/lapsed transition, never the
  became-active one - see the CORNER ZONES section above). This was a
  deliberate cleanup (v2.37.0 removed the rain rune's activate/top-up toast
  and the grow spell's fire toast entirely) - don't add a new one back in
  for a future spell's own cast/activate moment.
- **No camera moves the player didn't initiate.** Casting or a spell's
  effect completing should never fly/pan the map on its own (the
  welcome-back tour that used to do this for "here's what happened" status
  was removed in v2.37.0 for the same reason) - if something needs
  surfacing, it waits for the player to look, the same way a grown flower
  or a lapsed zone just sits there until they check on it.
- **No in-game hint for *discovering* a spell's formation** - a player
  still has to stumble into or work out a recipe themselves, the same
  "discovery is part of the design" principle as always. What changed
  (v2.40.0-ish): there IS now a real, general-access Spell Book page
  (search `SPELL BOOK` - `renderSpellbookPage`/`syncSpellbookUnlockUI`)
  that documents a spell *after* it's already been found, not before -
  each spell's own card stays a locked silhouette (`lockedSpellCard`)
  until its own discovery predicate is met (`isRainRingUnlocked` and
  siblings - each mirrors whichever axis that spell's recipe treats as
  the fixed, exhaustively-required one: every species in one fixed color,
  or every color of a tier, discovered via `recordGrown`). A new formation
  spell should get its own such predicate and card in the same pattern
  rather than skipping the Spell Book entirely - it's the documented
  convention now, not an opt-in.
- **Comment-as-spec**: every constant and section here carries a full
  prose explanation of the mechanic, not just a one-line label. Future
  changes (including AI-assisted ones) lean on these comments instead of
  re-deriving intent from the code - keep writing them that dense.
- **A spell's own boundary/visual is `interactive: false`** on its Leaflet
  layer (see `lokiZoneStyle`/`scryZoneStyle`/a rune's own boundary layers)
  - an outline must never intercept a tap meant for the ground underneath
  it. Don't add click handlers to a zone/rune outline; tap-to-inspect goes
  through the ground-tap dispatch instead. For a rune specifically, that's
  `runeAt`/`openRunePanel` (see the Runes section above), wired into
  `map.on('click')` and `resolveSeedTap` - **not** `toolTargetAt`, which is
  a different thing entirely: what an equipped *tool* (water/shear/sell/
  fert) acts on during a press-and-hold, not what a bare or seed-equipped
  tap opens an info panel for. A zone (Loki/Scry) has no separate rune
  object of its own to tap - its corner flowers are ordinary plants, so the
  normal plant-tap dispatch already covers them.
