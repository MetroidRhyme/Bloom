---
name: bloom-magic
description: Use when adding, changing, or reasoning about one of Bloom's elemental spells - plant-configuration effects like the Rain Ring (a shape/color of flowers that triggers something once grown). Covers the established architecture (derived non-persisted detection, the shared auto-watering animation machinery, rune/boundary art conventions, protecting a spell's anchor tile) so a second spell follows the same pattern as the first instead of reinventing it. Not for ordinary gameplay features unrelated to a plant-shape-triggers-an-effect mechanic.
---

# Bloom's elemental spells

The premise (the player's own words, kept verbatim since it's the spec):
plant flowers in a specific shape or color and, once grown, something
happens - casting a spell with flowers. The first one, the **Rain Ring**
(8 blue flowers around one empty tile, all grown to a full cluster, keeps a
5x5 area watered on its own), shipped across a handful of rounds and
settled into a real pattern. Read this before building spell #2 so it
reuses that pattern rather than inventing a parallel one.

**Deliberately no in-game explanation yet.** No toast, tutorial step, or
spellbook copy tells the player why this happened - "no in-game way of
figuring out that this happens" was explicit from the start, with a
spellbook/delivery mechanism planned as a separate later feature. A new
spell should stay just as silent until the user says that's changed. A
*visible* effect (a rune, a droplet animation) is not the same thing as an
*explanation* - the player should be able to see something is happening
without the game ever telling them the recipe.

**Avoid pentagrams / 5-fold symmetry** in any "magic circle" art - called
out explicitly for the Rain Ring's rune. An 8-point compass star (two
squares 45deg apart) reads as arcane/runic without that association;
hexagons, plain circles, tick marks, and diamond glyphs are all safe too.

## The architecture, piece by piece

All of this lives together in one place in `index.html`: the **RAIN RINGS**
section, sitting right after `catchUpSprinklersOffline` (search for either).
Read that whole section before starting a second spell - it's the concrete
reference for everything below, not just a description of it.

### 1. Detection is derived, never persisted

`rainRings` is a plain top-level JS var (`{}`), **not** part of `state` -
unlike a player-placed object (a sprinkler), a spell's active/inactive
status is entirely a function of what's already sitting in `state.plants`,
so storing a second copy would just be one more thing that could drift out
of sync with the real garden or bloat the save. Instead:

- `recomputeXFull()` does one full, cheap rebuild - cheap because it only
  ever has to look at the small set of plants that could possibly matter
  (for the Rain Ring: blue flowers already at `MAX_STAGE`), never the whole
  garden. Called exactly **once**, at boot (`INIT`, right before
  `catchUpSprinklersOffline()`), so an old save that already happens to
  contain a qualifying configuration activates immediately on load.
- From then on, `refreshXCandidates(centers)` keeps it current
  incrementally: re-tests a small batch of candidate tiles and adds/removes
  them from the registry, redrawing map layers once at the end if anything
  changed. No other full rescan is ever needed for the rest of the session.

### 2. Hook into the handful of places `state.plants` actually mutates

There are exactly four - grep `state\.plants\[.*\] = {` and
`delete state\.plants\[` to confirm this is still true before adding a
spell, in case something new has been added since:

| Site | What changed | What to check |
|---|---|---|
| `plantSeedAt` | a tile just became occupied | could this tile have been a candidate *center*? |
| `doBreed` | a bred seedling just landed | same as above |
| `harvestPlant` | a tile just became empty | could removing this break a ring it was a *spoke* of, or free up a candidate center? |
| `applyWatering`, the `stage >= 3 && !reachedFlourish` block | a flower just reached MAX_STAGE for the first time | could this newly qualify as a *spoke*? |

Each hook computes `candidateXCentersAround(q, r)` (the changed tile itself
plus its `CELL_NEIGHBORS`) and calls `refreshXCandidates` on that batch -
cheap and localized, never a full-garden rescan. A different spell shape
(not "8 around 1 empty center") needs its own version of "which candidate
positions could this tile change the status of", but the hook *sites*
(these same four) stay the same regardless of shape.

### 3. Effect delivery reuses the sprinkler's tick + offline-catchup pair

Don't build a new watering pathway - a spell that "does something to
nearby plants over time" is mechanically the same problem a sprinkler
already solved:

- A live `tickX()` on its own short `setInterval` (see `RAIN_TICK_MS`),
  purely detection - for each qualifying plant, hand off to `startXWatering`
  and move on, exactly the shape `tickSprinklers` already has.
- `catchUpXOffline()`, called right after `catchUpSprinklersOffline()` at
  every resume point (visibilitychange, `onGpsLocked`, and once at boot) -
  replays the same wilted-or-ready check across however long the tab was
  closed, in one shot, bypassing animation entirely (see
  `catchUpSprinklersOffline`'s own comment for why replaying a multi-day
  gap one droplet at a time makes no sense). **Order matters**: run it
  *after* the sprinkler catch-up, since a sprinkler could have grown a
  blue flower to MAX_STAGE during the same gap and newly completed a ring -
  the applyWatering hook (point 2 above) keeps the registry correct through
  that automatically, no extra wiring needed.
- The droplet-flight animation itself (`playWaterDroplets`,
  `startXWatering`, `finishAutoWatering`, the shared `autoWaterAnimKeys`
  guard) is already generalized to take any `{lat, lng}` source, not just a
  sprinkler - reuse it rather than duplicating the Bezier-curve flight
  code. A plant in range of two different auto-watering sources (a
  sprinkler and a spell, or two spells) is guarded against double-animating
  by that one shared `autoWaterAnimKeys` map.

### 4. Map art conventions

**The rune** (the effect's "anchor" marker, if it has one): an SVG string
built by a `buildXRuneSVG(px, idSuffix)` function, wrapped in an
`L.divIcon`. Two things this must get right:

- `idSuffix` on every `<radialGradient>`/other `<defs>` id, unique per
  ring instance (e.g. the sanitized cell key) - divIcon markup becomes real
  sibling DOM nodes on the live page, so two simultaneously active
  instances sharing an id is invalid HTML even if usually harmless.
- Size it off `plantIconBase()` (the live on-screen px width of one tile),
  the same input every other map icon uses, and hook into the *existing*
  rescale machinery rather than inventing a parallel one: set
  `_iconBuiltPx` when built, give the marker an `_iconKey` so
  `renderX()` only rebuilds the icon when px actually changed, add it to
  `rescalePlantIcons()`'s live in-gesture CSS-transform loop, and call
  `renderX()` from `scheduleMarkerRender()` (the moveend/zoomend handler).

**Range/boundary decoration**: real lat/lng Leaflet vector layers
(`L.polygon`/`L.polyline`), the same family `rangeArea` (the plant-range
preview) already uses - not pixel markers. They reproject for free on
pan/zoom with zero rescale code needed, which pixel icons don't get for
free. `cellRingLatLngs`/the geometry helpers in the RAIN RINGS section
(`rainBoundaryGeometry`) show the pattern for turning a center + radius
into corner/edge points in lat/lng space.

**Never let a boundary glyph poke past its own line.** The Rain Ring's
edge-midpoint diamonds originally sat on a tick that pointed *outward* past
the watered zone - a flower planted in the very next tile outside could
end up visually overlapping one. The fix, worth repeating for any future
boundary decoration: don't center a symmetric shape exactly on the
boundary line (it straddles both sides no matter what) - shift its center
*inward* by its own half-width first, so the single point that would have
poked outward lands exactly on the line instead, and the rest of the shape
sits inside the zone.

### 5. Protect the spell's own required-empty tile

If a spell needs a tile to stay empty (the Rain Ring's center) to keep
working, block planting on it *at the source*, everywhere a seed can land -
don't rely on the detection hooks to just clean up after the fact once
something gets planted there and breaks it. In practice that means routing
every planting path through one shared occupancy predicate:

- `cellFree(q, r)` is that predicate - already checked plants/wild/
  sprinklers, extended to also check the spell's own registry. Any new
  spell with the same "keep this tile empty" requirement should extend
  `cellFree` too, rather than adding a parallel check.
- Callers that go through `cellFree` already (`breedSpotFor`) get the
  exclusion for free. Callers that had their own inline occupancy check
  (`applyRangeSeedAction` used to) should be switched to call `cellFree`
  instead of maintaining a second copy of the same logic.
- The single-tap path (`resolveSeedTap`) needs its own explicit check and
  toast, since it's the one path that owes the player direct feedback
  (mysterious flavor, not an explanation - e.g. "Something's anchored
  here - it can't be planted on") rather than silently skipping.
- `plantSeedAt` itself re-checks defensively and returns `null` rather than
  planting, the same "don't fully trust the caller" pattern already used
  for its seed-count check just above - a last line of defense for any
  caller that forgot the `cellFree` check up front.

## Testing a spell change

See the `bloom-playtest` skill for the harness itself - two things there
are specifically relevant to spells: forcing `reduceMotion = true` to
collapse the auto-watering animation to a synchronous call when you only
care about the end state, and setting `state.userPos` directly since
headless geolocation never actually locks in this sandbox. Build state
directly via `page.evaluate` (a ring of flowers at `MAX_STAGE`, etc.)
rather than trying to walk through real growth timers.
