---
name: bloom-perf
description: Use whenever Bloom's frame rate, smoothness, battery drain, or general slowness is in play - "it gets choppy", "it lags after a while", "the map stutters when I pan", "it's eating my battery", "make it faster", "optimize this" - and ALSO before adding anything that renders per-entity on the map (a new marker type, rune, overlay, animated flourish, per-tick render call, or anything that calls saveState in a loop), since those are exactly the changes that have historically caused the slowness. Explains where Bloom's frame budget actually goes (measured, not guessed), the four standing cost controls already in the code (ambient motion budget, viewport virtualization, coalesced saves, adaptive GPS polling) and the invariants each one imposes, plus how to profile the game rather than speculate about it.
---

# Bloom performance

Bloom's frame budget is not spread evenly across the code. One category of
cost dwarfs everything else, and it is not the category people guess. Before
optimizing anything here, read this - and then measure, because the intuitive
answer has been wrong every time it has been checked.

The measurements below were taken in headless chromium (software raster, no
GPU) against a 1500-plant lifetime save. Treat them as ratios, not absolutes;
a real phone differs in magnitude but the ordering has held.

## The dominant cost: animated elements inside inline SVG

Every swaying grass clump, stem, bloom halo and spark is an animated element
*inside* a marker's inline SVG. Chrome cannot promote those to a compositor
layer, so **each one repaints its entire SVG on the main thread every frame,
forever, for as long as it is on screen.** There are about 6 per flower
marker.

The cost is strictly linear in how many are on screen:

| markers on screen | animated groups | frame time (p50) |
|---|---|---|
| 351 | 2124 | **117 ms** (8 fps) |
| 351, animations off | 2124 | **16.7 ms** (60 fps) |
| 945 | 5696 | 350 ms (3 fps) |
| 473 (same scene, half removed) | 2864 | 183 ms |
| 945, animations off | 5696 | 16.7 ms |

Same markers, same pixels, animation the only variable - and halving the
markers halves the frame time almost exactly. This is the whole ballgame. If
Bloom feels slow, start here.

**Things that do not help, verified:** `will-change: transform` on the
animated groups (measurably *worse* - 116ms to 133ms), `contain: paint` or
`will-change` on the marker element, and any other compositor hint. SVG child
elements genuinely cannot be composited independently; there is no CSS trick
waiting to be found. The only lever is **how many are animating at once.**

## The four standing cost controls

These are already in the code. Each one exists because of a specific measured
failure, and each imposes an invariant a later change can silently break.

### 1. Ambient motion budget (`WIND_ANIM_BUDGET`, `applyWindBudget`)

Only the N markers nearest the middle of the screen sway; the rest render
byte-identical markup and hold still. All ambient marker/overlay motion is
also suspended outright for the length of a pan or pinch (`body.map-moving`).

Why a budget and not more culling: viewport virtualization already bounds
cost by what is *visible*, but not by **density** - and density is what grows
over the life of a save. A player who has spent months filling in their own
neighbourhood ends up with every on-screen tile planted. That is the reported
"it gets choppy after a while", and no amount of further culling addresses it,
because everything on screen legitimately is on screen.

Budget sweep at 351 markers on screen: 60fps holds to a budget of ~40, drops
to 30fps at 80, 8fps unbudgeted. The shipped value of 16 is deliberately well
inside that margin, since the headless numbers understate a mid-range phone.
It is a plain `var` - tune it if the map reads as too still, but re-measure.

**Invariant:** `.no-wind` is applied to the marker's own element, and Leaflet
`setIcon()` replaces that element - so any render path that rebuilds icons
must call `scheduleWindBudget()` afterwards. `renderPlants`/`renderWild`/
`renderWeeds` already do; a *new* marker type with its own ambient animation
needs the same call and needs collecting inside `applyWindBudget`.

**The rule for new work:** adding another infinitely-animating element to a
marker is the single most expensive thing you can do in this codebase. It
costs every frame, for every copy on screen, forever. If a new flourish is
worth it, it comes out of the same budget - not alongside it.

### 2. Viewport virtualization (`MARKER_VIEWPORT_PAD`, `boxInMarkerViewport`)

Nothing gets a Leaflet layer built for it unless its tile is in (or near) the
current viewport. This covers plants, wild flowers, sprinklers, weeds, rain
runes and grow runes.

Runes were the later addition and the more valuable one per entry: a single
rain ring is **seven** Leaflet vector layers (center glyph, tile lattice,
circle, two stars, ticks, diamonds), all real lat/lng geometry that Leaflet
reprojects on every zoom and viewreset. Before virtualization every ring the
player had ever completed kept all seven alive forever, anywhere on Earth, so
zoom cost grew with the lifetime count of rings rather than with what was on
screen.

**The rule for new work:** anything that renders one-layer-per-entry from a
registry that grows over the life of a save must be viewport-virtualized. The
existing `seen`-sweep teardown pattern makes this cheap to add.

Two traps, both real:

- **Bookkeeping before the viewport check, drawing after.** `renderGrowRunes`
  prunes expired runes out of `state.growRunes`. That prune is real state
  mutation, not drawing - if it sits behind the viewport filter, off-screen
  runes never expire and accumulate in the save forever. Order matters.
- **`_iconBuiltPx` is written before the filter, unconditionally.** See the
  zoom-rescale gotcha in `bloom-spells` - the shared baseline must still be
  updated even on a pass where nothing was in view.

Runes are virtualized; **Loki/Scry corner zones deliberately are not.**
`renderZoneRegistry` fires the "a corner wilted" toast on an active-to-dormant
transition, and that toast is the only way a player learns about it without
walking back. Virtualizing the layers would silently drop the transition
detection for off-screen zones. If this ever needs doing, split the two:
track `active` for every zone, build polygons only for visible ones.

### 3. Coalesced saves (`saveState` / `writeSaveNow` / `flushSave`)

The save blob is the *whole* state - every plant, every visited tile - and
`localStorage.setItem` is synchronous. Measured at ~590KB and 4-11ms per
write on desktop, and it grows for the entire life of a save.

There are 50-odd call sites and several fire in bursts: one walk step saves
twice (`markAccessible`, then `markTileControl`), and every sprinkler or
rain-ring droplet landing saves again via `finishAutoWatering` - which with a
few sprinklers running was several full saves a second, each writing state the
next one was about to overwrite.

`saveState()` now marks dirty and throttles; at most one real write per
`SAVE_DEBOUNCE_MS`. Callers are unchanged and keep their plain "I changed
something, save it" contract - **keep it that way.** Do not push flush
decisions out to call sites; that is exactly the coupling this design avoids.

**Invariants:**

- Durability rides on the forced flush at `visibilitychange`-to-hidden and
  `pagehide`. On mobile a tab is usually killed while backgrounded rather
  than closed, so the visibility one is the load-bearing half - don't remove
  it.
- `flushSave()` only writes when dirty. A test or code path that mutates
  `state` directly and then calls `flushSave()` writes **nothing**; it has to
  go through `saveState()` first. This is easy to trip over when writing
  fixtures.
- Anything that erases or replaces the save must call `cancelPendingSave()`
  first, or a queued write lands after the wipe and restores it. `onResetSave`
  is currently the only such path.

### 4. Adaptive GPS polling (`GPS_BACKOFF_STEPS`, `noteGpsActivity`)

Polling (not `watchPosition`) was already the right call - it lets the radio
power down between fixes. On top of that, the cadence now stretches from 5s to
15s/30s/60s the longer nothing suggests the player is moving, and snaps back
to 5s on a tile change or **any touch anywhere on the screen**.

The touch hook is the part worth preserving: someone who has picked the phone
up and is looking at Bloom is exactly who is about to start walking, and a
touch is a much earlier signal than the next fix would be. It reduces the
worst case from "one backed-off interval of missed walking" to nearly nothing.

**If asked for a manual GPS on/off toggle, push back once before building
it.** A toggle has to be remembered in both directions, and the failure mode
of forgetting to turn it back on is severe and silent: a whole route walked
with no tiles granted, flowers left unwaterable, progress lost with no error
to explain it. The adaptive version gets most of the battery saving with no
such cliff. Build the toggle if the user still wants it after hearing that -
it's their game - but don't ship it as the first answer.

A further option not yet taken: drop to `enableHighAccuracy: false` while
backed off (much cheaper - wifi/cell rather than GPS) and re-acquire high
accuracy on detecting movement. Deliberately skipped because a 50-100m fix can
manufacture spurious tile changes, which grant range the player never earned.

## Smaller wins already taken (don't reintroduce the patterns)

- **`updateHUD`** walks the garden once, not four times. It used to chain
  three `Object.keys().filter()` passes; it runs on every GPS fix and every
  60s tick forever.
- **`syncPlantCycleArrows`** asks `Object.keys(state.plants).length > 1`. It
  used to call `sortedPlantKeys()` - a comparator sort of the entire lifetime
  garden - purely to decide whether to show two chevrons.
- **`setStatusLine` and the seed/sprinkler toggles** skip `innerHTML` writes
  when the markup is unchanged. An identical `innerHTML` assignment still
  costs a parse and a subtree rebuild, and these are called ~12 times a minute
  with nothing changed.
- **`renderGridMesh`** precomputes per-row and per-column pixel edges instead
  of projecting all four corners of every cell (~70 projections per redraw
  instead of ~4000) and uses `fillRect` rather than a 4-point path per tile.
  This is exact, not an approximation: Mercator maps lng to x and lat to y
  independently, so every cell in a column shares its x edges. 1.71ms to
  0.27ms, verified pixel-identical.

The through-line: **anything on the per-frame, per-GPS-fix, or per-minute-tick
path should do work proportional to what changed, not to the size of the
save.** Most of these were O(lifetime garden) doing constant-sized work.

## Profiling instead of guessing

Do not optimize Bloom from reading. Every time this has been measured, the
ranking surprised somebody. The harness lives in `bloom-playtest` - see its
"Profiling and performance regression" section for the frame-sampler, the
fixture that builds a realistic lifetime save, and the pixel-diff that proves
an optimization changed nothing visually.

The two numbers that matter most:

- **Long-frame count while idle** (`frames > 20ms` out of ~115 sampled). This
  is what "choppy" actually means. Ambient animation dominates it.
- **Per-call cost of the tick/fix path** (`saveState`, `updateHUD`,
  `renderGridMesh`, `onLocationUpdate`). These are the O(save size) risks.

An A/B against the shipped build is usually more informative than an absolute
number - run the same harness against `git show HEAD:index.html` and compare.

## Before shipping a performance change

A perf change that alters what the game looks like is a redesign, not an
optimization, and needs to be discussed as one. Prove it didn't:

1. Pixel-diff the map against the previous build under reduced-motion (which
   freezes every ambient animation on both sides, so only real rendering
   differences survive). `bloom-playtest` has the recipe. Byte-identical PNG
   is the bar, and it is reachable - every optimization in v2.38.0 met it.
2. Re-run the zoom-rescale walk. Icon sizing is the invariant most easily
   broken by touching render batching, and it fails silently.
3. Report the before/after numbers in the commit body. There is no CI here;
   the commit message is the only record that the measurement happened.
