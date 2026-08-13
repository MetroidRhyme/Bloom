---
name: bloom-playtest
description: Use when verifying Bloom UI/game-logic changes with Playwright, or when asked for a standalone/isolated demo build of one Bloom subsystem, or when a JS-driven playtest build isn't loading for the user and a dependency-free static reference is needed instead. Covers the headless-chromium test harness, the splice-a-standalone-tool pattern, and the static-bake fallback.
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
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium/chrome-linux/chrome' });
  ```
  (`/opt/pw-browsers/chromium` is a symlink to whatever build is actually
  installed.)
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
