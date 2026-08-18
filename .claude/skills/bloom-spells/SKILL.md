---
name: bloom-spells
description: Use when the user wants to add, modify, or reason about one of Bloom's "basic elemental magic" spells (planting-formation mechanics like the RAIN RING, GROW SPELL, LOKI'S CONTROL, SCRY) or asks for a new one. Explains the existing spell architecture in index.html - the consuming-vs-persistent design fork, the shared CORNER ZONES foundation, the tier system, and the checklist for wiring in a new tier-gated formation spell - so a new spell reuses existing machinery instead of re-deriving it from scratch.
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

**Cross-spell interaction to know about:** a 2x2 block whose four flowers
all happen to match (same species+color) and are tier-1 is *simultaneously*
a valid GROW SPELL recipe. The grow spell fires unconditionally the moment
such a block completes, consuming it before a Loki zone referencing the
same tile could ever register. A deliberately mixed corner (any one of the
four flowers differing) is immune. If you add a new tier-1 formation spell,
it inherits this same risk - either warn about it in the comments (as Loki
does) or move the new spell to a still-open tier.

## The CORNER ZONES foundation (shared by LOKI'S CONTROL and SCRY)

Both spells use the same shape - four 2x2 corner blocks of one tier at the
corners of a rectangle between `ZONE_MIN_SPAN` and `ZONE_MAX_SPAN` tiles on
a side - so the detection/rendering is genuinely shared, not copy-pasted.
Search `CORNER ZONES` for the section banner. The reusable pieces:

- `isCornerBlockOfTier(q, r, tier)` - is the 2x2 anchored at (q,r) a
  complete, grown, single-tier block? (Flowers don't need to match each
  other - that's a GROW SPELL-only constraint.)
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
  style and an `onTransition(active)` callback for the active<->dormant
  toast.

A new tier-based rectangle-corner spell is almost entirely boilerplate on
top of this foundation - see `lokiZones`/`scryZones` and their thin
wrapper functions (`refreshLokiZoneCandidates`, `recomputeLokiZonesFull`,
`isInActiveLokiZone`, `lokiZoneStyle`, `renderLokiZones`, and the Scry
equivalents) immediately below the CORNER ZONES section for the ~10-line
pattern to copy: a registry var, three one-line wrapper functions, a style
function, and a render function. The *effect* (what being "in an active
zone" actually does) is always spell-specific and lives outside this
section - Loki's is in `markAccessibleToday`/`inRange` (extends
`state.lokiAccess` timestamps), Scry's is a single unconditional check
added to `inRange` directly, with no persisted state at all.

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
   needs none of this.
9. Test via the `bloom-playtest` skill - and specifically its own gotcha
   about routing growth through `waterPlant()` rather than raw
   `applyWatering()` when the test needs to exercise a call-site-hooked
   (consuming) spell's trigger.
10. Ship via the `bloom-ship` skill - version bump, changelog entry written
    for a player (what the spell does, not the registry/tier mechanism
    behind it), the works.

## Design conventions worth keeping

- **No in-game hint/tutorial for these spells** (per the original RAIN_RING
  comment) - discovery is part of the design, at least for now. Don't add
  a spellbook UI unless asked.
- **Comment-as-spec**: every constant and section here carries a full
  prose explanation of the mechanic, not just a one-line label. Future
  changes (including AI-assisted ones) lean on these comments instead of
  re-deriving intent from the code - keep writing them that dense.
- **A spell's own boundary/visual is `interactive: false`** on its Leaflet
  layer (see `lokiZoneStyle`/`scryZoneStyle`/the rain rune's boundary
  layers) - an outline must never intercept a tap meant for the ground
  underneath it. Don't add click handlers to a zone/ring outline; if a
  spell needs tap-to-inspect, gate it through the existing
  plant/rune-tap dispatch (`toolTargetAt`) instead of the boundary shape
  itself.
