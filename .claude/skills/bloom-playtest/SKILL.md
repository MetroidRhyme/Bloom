---
name: bloom-playtest
description: Use when verifying Bloom UI/game-logic changes with Playwright, when profiling Bloom's frame rate or proving a performance change didn't alter what the game looks like, when asked for a standalone/isolated demo build of one Bloom subsystem, or when a JS-driven playtest build isn't loading for the user and a dependency-free static reference is needed instead. Covers the headless-chromium test harness, building a realistic lifetime-save fixture, frame-time sampling, pixel-diffing the map against the previous build, A/B-ing a suite against the shipped code, testing zoom-dependent map behavior (marker icon sizing) against the real Leaflet map, the splice-a-standalone-tool pattern, and the static-bake fallback.
---

# Testing and demoing Bloom

Bloom has no build step and no CI, so verification is: launch headless
chromium against the actual file and drive it. This skill covers the three
techniques that have worked repeatedly.

## Environment facts (this sandbox)

- `playwright-core` is what's available (not full `playwright`) - install it
  into a scratch dir once per session: `npm install playwright-core` in
  e.g. `<scratchpad>/pw-test/`.
- Chromium is pre-installed. Use the **stable, version-independent** path -
  don't hardcode a `chromium-NNNN` build number, it changes:
  ```js
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  ```
  `/opt/pw-browsers/chromium` is a symlink straight to the `chrome`
  executable itself (e.g. `chromium-1194/chrome-linux/chrome`), not to a
  directory - don't append `/chrome-linux/chrome` after it, that path
  doesn't exist and `launch()` fails with ENOENT. Run
  `ls -la /opt/pw-browsers/` first if this ever changes again.
- **A working suite is already committed at `tests/` - start there, don't
  rebuild one.** `./tests/setup.sh` (installs playwright-core, fetches
  Leaflet; both gitignored) then `./tests/run-all.sh`. It carries
  `harness.js` (browser launch, CDN interception, geolocation stub, the GPS
  lock, the standard fixtures, frame sampling, PNG decoding),
  `regression.js`, `zoom.js`, `pixel-diff.js` and `perf.js`, and
  `tests/README.md` lists the traps that waste the most time. Everything
  below is the reasoning behind what that harness does; read it when
  extending the suite or when something behaves oddly, not to reimplement
  it. Ad-hoc probes still belong in the scratchpad - only things worth
  running again belong in `tests/`.

## 1. Testing the real `index.html` (needs Leaflet + geolocation stubbed)

`index.html` loads Leaflet from a CDN and drives a Leaflet `map` object that
can't fully initialize in a sandboxed headless run, and it gates a lot of
UI behind `navigator.geolocation`. Route around both rather than fighting
them:

```js
const path = require('path');
await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js',
  route => route.fulfill({ path: path.resolve(__dirname, 'leaflet.min.js') }));
await page.route('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css',
  route => route.fulfill({ path: path.resolve(__dirname, 'leaflet.min.css') }));
await page.route('https://*.tile.openstreetmap.org/**', route => route.abort());
await page.route('https://*/**tile**', route => route.abort());

await page.goto('file:///home/user/Bloom/index.html');
await page.waitForTimeout(300);

// Inside page.evaluate(), before exercising game logic:
renderPlants = function () {};
renderWild = function () {};
```

Vendored `leaflet.min.js`/`leaflet.min.css` need to already exist next to
the test script (copy them into the scratchpad `pw-test/` dir once). The
aborted tile requests will show up as `console.error` `ERR_FAILED` lines -
that's expected noise, filter it out rather than treating it as a real
error:

```js
page.on('console', msg => {
  if (msg.type() === 'error' && !msg.text().includes('ERR_FAILED')) errors.push(msg.text());
});
```

Set the `state` directly via `page.evaluate` for whatever scenario you're
testing (currency, unlock flags, `state.greenhouse.pots`, etc.) rather than
trying to drive the UI through real walking/GPS.

**Gotcha: `q`/`r` and lat/lng are not independent - a fabricated fixture
must derive one from the other.** `cellCenter(q, r)` is literally
`{ lat: r * CELL_LAT_DEG, lng: q * CELL_LNG_DEG }` - the grid has no
separate origin offset, `q`/`r` *are* lat/lng divided by cell size. Any
in-game structure that carries both fields (a rain ring, a sprinkler, a
plant) always has them agree because they're derived from the same
`cellCenter()`/`latLngToCell()` call. If you hand-build a test fixture with
an arbitrary `q`/`r` (e.g. `{q:0,r:0}`) but a real-world `lat`/`lng` (e.g.
San Francisco) to make a marker land somewhere visible, anything that reads
`q`/`r` to compute *geometry* (a boundary shape drawn in real lat/lng, a
range check) will silently place that geometry at the `q`/`r`-implied
location instead - which can be nowhere near your marker and off-screen
entirely, with no error to flag it. Always compute both from one source:
`var c = cellCenter(q, r); rainRings[k] = { q: q, r: r, lat: c.lat, lng: c.lng };`
then `map.setView([c.lat, c.lng], zoom)` - not the other way around.

**Gotcha: lock GPS *before* building any fixture, or the fixture lands at
coordinates the viewport math will never match.** `onGpsLocked` rewrites the
global `CELL_LNG_DEG` once, correcting it for the player's latitude, and then
persists it to `bloom_cell_lng`. Every `q`/`r` is lat/lng divided by that
constant (see the gotcha above), so a fixture built *before* the lock is
indexed against the uncorrected value and every one of its tiles sits ~26%
further out (at SF latitudes) than anything computed after. The symptom is
maximally confusing: no error, no console output, `state.plants` full of
perfectly valid-looking entries, and `renderPlants()` building **zero**
markers because `viewportCellBounds()` returns a `q` range nowhere near the
fixture's. Note the lock does not happen just because you waited - with a
brand-new save, `state.gpsPrimerSeen` is false, so the GPS primer modal opens
and `requestLocation()` is never called at all. Force it yourself first:

```js
// twice: the first call creates rangeArea and triggers onGpsLocked (which is
// what rewrites CELL_LNG_DEG), the second runs against the corrected value
onLocationUpdate({ coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 } });
onLocationUpdate({ coords: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 } });
var here = latLngToCell(37.7749, -122.4194);   // only NOW is this stable
```

If a test reports zero markers for a garden you know you just built, this is
almost always why. Print `latLngToCell(lat, lng)` next to
`viewportCellBounds(0.5)` and compare the `q` ranges - a clean ~1.26x ratio
between them is the fingerprint.

**Gotcha: a test helper that fast-forwards growth by calling `applyWatering`
directly can silently skip a spell's own trigger.** Several mutation hooks
(the grow spell's `checkGrowBlocksAround`, for instance - see the
`bloom-spells` skill) are deliberately wired in at the *call sites*
(`waterPlant`/`finishAutoWatering`/`catchUpSprinklersOffline`), not inside
`applyWatering` itself, specifically so a batch/offline loop can't delete a
plant out from under itself mid-iteration. A test convenience like:
```js
function growAllToMax(k) {
  var p = state.plants[k];
  while (p.stage < MAX_STAGE) { p.readyAt = Date.now(); applyWatering(p, Date.now()); }
}
```
grows the flower correctly but silently never fires anything hooked at the
call-site level - the assertion just fails ("why didn't my block get
consumed?") with no error to point at the real cause. Route growth helpers
through the real `waterPlant(key)` (re-fetching `state.plants[key]` each
loop iteration, since it may now be `undefined` if that watering consumed
it) whenever the test needs to exercise a spell's actual trigger, and only
reach for raw `applyWatering` calls when you specifically want to bypass
those hooks (e.g. building a fixture state before testing detection in
isolation).

**Gotcha: testing zoom-dependent behavior needs a real `zoomend` await, not
a fixed sleep - `setZoom()` can silently no-op or get clamped.** A naive
`map.setZoom(z); await page.waitForTimeout(300)` loop breaks in two ways
that both produce flaky, misleading pass/fail results rather than a clean
error: (1) if the requested zoom already equals whatever the map is sitting
at, `setZoom` is a no-op and `'zoomend'` never fires, so a bare
`page.evaluate(() => new Promise(r => map.once('zoomend', r)))` hangs
forever - check `map.getZoom() === zoom` first and resolve immediately
instead; (2) the map's actual `minZoom`/`maxZoom` (`map.getMinZoom()`/
`getMaxZoom()`, roughly `[14, 19]` in Bloom, not the Leaflet default) can
silently clamp a requested level to something else entirely, so read back
`map.getZoom()` after the fact rather than trusting the value you asked
for. Always pass `{ animate: false }` too - an animated zoom still mid-
flight can leave the *next* `setZoom` call ignored until the current
transition finishes, which reads as a missing zoom step with no error.
Put together:
```js
await page.evaluate((zoom) => new Promise((resolve) => {
  if (map.getZoom() === zoom) { resolve(); return; }
  map.once('zoomend', resolve);
  map.setZoom(zoom, { animate: false });
}), targetZoom);
```
This combination is what actually caught the grow rune's icon-size-on-zoom
bug (see the `bloom-spells` skill's Runes section, "live zoom rescale") by
walking the real map through several non-monotonic zoom levels and
comparing each marker's actual rendered `<svg width>` against
`plantIconBase()*<its own scale factor>` after every step - the fixed-sleep
version of the same test produced inconsistent results that didn't clearly
point at the real bug.

**Gotcha: `regression.js` runs every section on one page in sequence, so a
zoom level left over from an earlier section silently changes what a later
section's *fixed tile offset* actually tests.** A check like "the tile 6
columns over from the player is/isn't painted" implicitly assumes how many
real tiles fit across the current viewport width - and that shrinks at
higher zoom, since each tile takes up more screen pixels. If some earlier
section zoomed to test icon rescaling or a zoom-dependent pattern (see the
gotcha above) and never zoomed back, a later section's offset can land
outside the viewport-culled render loop entirely and read as "not
painted" for a reason that has nothing to do with whatever the check was
actually written to test - no error, no crash, just a wrong-looking
failure that points at the feature instead of the leftover zoom (this is
exactly what happened writing the grass-scope regression check in
`bloom-range`: the check failed with the tile simply never reached by
`renderGridMesh`'s loop, not because the grass logic was wrong). Don't
assume a section inherits a known zoom from whatever ran before it - pin
it explicitly at the top of any section whose assertions depend on a
specific tile-to-pixel relationship:
```js
await page.evaluate(() => new Promise((resolve) => {
  if (map.getZoom() === 18) { resolve(); return; }
  map.once('zoomend', resolve);
  map.setZoom(18, { animate: false });
}));
```

## 2. Profiling and performance regression

Read `bloom-perf` for what the numbers mean and which ones matter; this
section is how to get them. All of it builds on the section 1 harness (CDN
interception, tile aborts, geolocation stub, GPS locked before any fixture).

### A realistic lifetime-save fixture

Perf problems in Bloom are problems of *accumulation*, so a fixture of ten
flowers proves nothing. Two shapes are worth having:

- **Lifetime save** - ~1500 plants scattered over a +/-120-tile "city" with a
  few dozen near the player, plus ~6000 `state.visited` tiles. This is what
  exercises the O(save size) paths: `saveState`, `updateHUD`, `tickPlants`.
- **Dense viewport** - every tile on screen planted (~350 markers at zoom 18
  on a 420x900 viewport). This is what exercises the per-frame paths, and it
  is a *plausible* save, not a pathological one: a player filling in their own
  neighbourhood over months arrives here.

Derive lat/lng from `cellCenter(q, r)` and never the other way round (see the
`q`/`r` gotcha in section 1), and seed the randomness so runs are comparable.

### Frame-time sampling - the number that means "choppy"

Per-call microbenchmarks miss the actual complaint. Sample real frame deltas:

```js
const frames = await page.evaluate(() => new Promise((resolve) => {
  var d = [], last = performance.now(), n = 0;
  function tick(t) { d.push(t - last); last = t; if (++n < 140) requestAnimationFrame(tick); else resolve(d); }
  requestAnimationFrame(tick);
}));
const s = frames.slice(10).sort((a, b) => a - b);   // drop warm-up frames
// report p50, p95, and the count over 20ms
```

Report **frames over 20ms out of the sample** alongside p50/p95. A p50 of
16.7ms with 40% of frames long is a real stutter that a mean would hide.

To attribute a cost, toggle one thing and re-sample in the same page - much
faster and less noisy than separate runs. Injecting a `<style>` override is
the easiest scalpel:

```js
// isolate ambient animation cost without touching the file
await page.evaluate(() => document.body.classList.add('bg-paused'));
// or override individual rules to bisect which animation is responsible
```

Sweeping a live constant works the same way - `WIND_ANIM_BUDGET` is a plain
`var`, so `page.evaluate((v) => { WIND_ANIM_BUDGET = v; applyWindBudget(); })`
gives a whole cost curve in one page load. That curve is how the shipped
budget was chosen; redo it rather than guessing a new value.

### Pixel-diffing the map (proving an optimization changed nothing)

This is the check that makes a rendering optimization safe to ship. Screenshot
`#map` on the old and new builds with `reducedMotion: 'reduce'` in the context
options - that freezes every ambient animation on *both* sides, so only real
rendering differences survive - then compare the decompressed PNG pixel data:

```js
const page = await browser.newPage({ viewport: { width: 420, height: 900 }, reducedMotion: 'reduce' });
// ... build the same seeded fixture, same setView, then:
await page.locator('#map').screenshot({ path: out });
```

```python
# compare raw pixels, not file bytes - PNG encoders are not deterministic
import zlib, struct
def raw(p):
    d = open(p, 'rb').read(); i = 8; idat = b''
    while i < len(d):
        ln = struct.unpack('>I', d[i:i+4])[0]; typ = d[i+4:i+8]
        if typ == b'IDAT': idat += d[i+8:i+8+ln]
        i += 12 + ln
    return zlib.decompress(idat)
print('IDENTICAL' if raw(a) == raw(b) else 'DIFFERS')
```

Get the previous build with `git show HEAD:index.html > /tmp/old-index.html`
and point the same script at each file in turn. Put everything visually
load-bearing in one shot - grid mesh, the today-access fill, markers across
several species and stages, a rain rune and a grow rune with their full
boundaries - so one comparison covers the lot. **Byte-identical is a
realistic bar**, not an aspiration: every optimization in v2.38.0 met it.

### A/B a whole suite against the shipped build

Take the target file as `process.argv[2]` in every test script. Then the same
suite runs against both builds, which separates "my change broke this" from
"this was already broken / my test is wrong" in one step - and it is
frequently the latter. Guard checks for functions that only exist on one side
so the script survives both:

```js
const hasFeature = await page.evaluate(() => typeof writeSaveNow === 'function');
console.log('-- save coalescing --' + (hasFeature ? '' : ' (SKIPPED - not in this build)'));
if (hasFeature) { /* ... */ }
```

The expected shape of a good result: the new build passes everything, and the
old build fails **only** the checks covering what you deliberately changed.
Anything else failing on both is a pre-existing issue or a harness bug - fix
the harness before reading anything into it.

### Perf checks worth keeping in the suite

Beyond frame timing, these caught real things and are cheap to assert:

- **Save coalescing behaves**: a burst of 200 `saveState()` calls collapses to
  a small number of real writes, the *last* value is what persists, and
  backgrounding force-flushes. Fake `document.hidden` with
  `Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })`
  and dispatch `visibilitychange`. Remember `flushSave()` writes nothing
  unless something called `saveState()` first - a fixture that mutates `state`
  directly and then flushes silently saves nothing.
- **Virtualization actually virtualizes**: put one entity on screen and one
  500 tiles away, assert only one layer set exists, pan to the far one, assert
  they swapped.
- **Off-screen bookkeeping still runs**: expire an off-screen grow rune and
  assert it left `state.growRunes` anyway. Easy to break by moving a viewport
  filter above a prune.

## 3. Building a standalone, dependency-free playtest tool

For handing the user something they can open and interact with, isolated
from Leaflet/GPS entirely (built for the Greenhouse; the same shape works
for any other self-contained subsystem):

1. Extract the relevant JS straight out of `index.html` into scratch
   source files - keep a clean split between shared/base logic (species,
   colors, flower-head rendering) and the feature-specific logic (state,
   growth engine, interaction functions), so a future round only needs to
   re-sync the piece that actually changed.
2. Write an HTML+CSS shell with a `__GH_LOGIC__`-style placeholder (adjust
   the token per feature) where the script goes.
3. Splice with a small Python script: concatenate the JS parts, `str.replace`
   the placeholder in the shell, write the result out. Keep this splice
   step itself simple enough to redo by hand each round - don't over-engineer it.
4. Use a **distinct `localStorage` key** from the real game (e.g.
   `bloom_greenhouse_playtest_v1` vs. the real `bloom_state_v1`) so the
   playtest can never clobber or read the player's real save.
5. Seed a demo scenario (a `buildDemoState()`/`loadDemoScenario()` pair)
   with timestamps computed relative to `Date.now()` at load time, not
   hardcoded epoch values, so the demo always looks fresh regardless of
   when it's opened. Give it a visible reset button.
6. Run the same ASCII scan + `node --check` + Playwright pass as any other
   Bloom change (see the `bloom-ship` skill, steps 1-3) before sending it.

Every round that touches the real feature's rendering/CSS needs the same
change ported into these scratch source files and re-spliced - it's easy to
ship a fix to `index.html` and forget the playtest silently drifts out of
sync. Treat "update the playtest" as part of the change, not an afterthought.

## 4. Static-bake fallback (when a JS-driven build won't load for the user)

If the user reports an interactive playtest "won't load" and the cause
isn't immediately obvious (and especially if it's happened more than
once), don't keep iterating on JS-driven builds blind - hand them something
that structurally cannot fail to execute: a plain HTML/CSS/inline-SVG
snapshot with **no `<script>` tag at all**.

```js
// Load the already-working interactive build in headless chromium, seed
// whatever demo state you want visible, then rip out the *rendered* DOM:
const data = await page.evaluate(() => ({
  headerHtml: document.getElementById('gh-header').outerHTML,
  wrapHtml: document.getElementById('greenhouse-wrap').outerHTML,
  styleHtml: document.querySelector('style').outerHTML,
}));
```

Then assemble a new standalone file from those three strings plus a
`<!doctype html>` wrapper - strip any `onclick="..."` attributes (regex
`/ onclick="[^"]*"/g`) since there's no script backing them anymore, and
skip anything that only makes sense interactively (modals, toasts, the
scenario-reset button). Verify the baked file the same way: load it
headless, screenshot it, confirm zero console errors.

This is a diagnostic downgrade, not a replacement - it proves the visuals
are correct but doesn't tell you *why* the interactive version failed for
the user. Still worth asking them directly what "won't load" looked like
(blank page? stuck spinner? visible error?) rather than only ever reaching
for this fallback.
