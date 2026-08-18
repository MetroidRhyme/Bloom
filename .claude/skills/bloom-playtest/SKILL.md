---
name: bloom-playtest
description: Use when verifying Bloom UI/game-logic changes with Playwright, or when asked for a standalone/isolated demo build of one Bloom subsystem, or when a JS-driven playtest build isn't loading for the user and a dependency-free static reference is needed instead. Covers the headless-chromium test harness, testing zoom-dependent map behavior (marker icon sizing) against the real Leaflet map, the splice-a-standalone-tool pattern, and the static-bake fallback.
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
- Playwright test scripts written to the scratchpad do **not** persist
  between sessions/containers. Either recreate the ones you need each
  session, or - if a script has proven itself worth keeping across many
  rounds of a feature (as the Greenhouse regression suite has) - consider
  proposing to the user that it get committed into the repo itself so it
  stops evaporating.

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

## 2. Building a standalone, dependency-free playtest tool

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

## 3. Static-bake fallback (when a JS-driven build won't load for the user)

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
