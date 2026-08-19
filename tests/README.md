# Bloom tests

Bloom has no build step and no CI. These scripts are the only thing standing
between a change and production, so they are meant to be run, not admired.

They live here rather than in a scratch directory because Playwright scripts
written to a session scratchpad do not survive between sessions, and rebuilding
them each time is a rediscovery exercise - most of the cost is not the code, it
is re-learning the handful of things that make headless Bloom behave.

## Setup (once per machine or container)

```
./tests/setup.sh
```

Installs `playwright-core` and fetches Leaflet into `tests/vendor/`. Both are
gitignored: Leaflet is third-party and playwright-core is large. Chromium is
expected at `/opt/pw-browsers/chromium`.

## Running

```
./tests/run-all.sh              # the full pre-ship pass
node tests/regression.js        # behaviour: 38 checks
node tests/zoom.js              # marker icon sizing across zoom levels
node tests/pixel-diff.js        # working copy vs HEAD, visually
node tests/perf.js              # profiling; prints numbers, asserts nothing
```

Every script takes an optional path so it can run against another build:

```
git show HEAD~1:index.html > /tmp/old.html
node tests/regression.js /tmp/old.html
node tests/pixel-diff.js /tmp/old.html index.html
```

Running the suite against the previous build as well as the working copy is
the fastest way to separate "my change broke this" from "this was already
broken, or my test is wrong" - and it is frequently the latter. A good result
looks like: the working copy passes everything, and the older build fails
**only** the checks covering what you deliberately changed.

## What each one is for

**`regression.js`** - the core loop (plant, water through all three stages,
harvest, sell), save coalescing and durability, reload round trip, rune
viewport virtualization, the ambient motion budget, HUD lines and badges,
GPS backoff, every panel, and that the live version has a changelog entry.
Checks covering code a given build may not have are skipped rather than
failed, so one script runs against both sides of a comparison.

**`zoom.js`** - marker icon sizing across a non-monotonic zoom walk. This is
the invariant most easily broken by touching render batching, and it fails
silently; see the script's own comment and the `bloom-spells` skill.

**`pixel-diff.js`** - screenshots the map on two builds and compares decoded
pixels. This is what makes a rendering optimization safe to ship: a perf
change that alters what the game looks like is a redesign, not an
optimization. Byte-identical is a realistic bar, not an aspiration.

**`perf.js`** - per-call costs on a realistic lifetime save, idle frame
timing, and a sweep of the ambient motion budget. Read the `bloom-perf` skill
for what the numbers mean.

## Things that will waste your time if you don't know them

**Lock GPS before building any fixture.** `onGpsLocked` rewrites the global
`CELL_LNG_DEG`, and `q`/`r` are lat/lng divided by it - so a fixture built
first is indexed against the uncorrected value and renders **zero markers**
with no error anywhere. `harness.lockGps()` exists for this. It also does not
happen on its own: a brand-new save shows the GPS primer instead of calling
`requestLocation()`.

**Derive lat/lng from `cellCenter(q, r)`, never the reverse.** A fixture that
pairs an arbitrary `q`/`r` with a real-world lat/lng puts a marker and its own
geometry in two different places, silently.

**`flushSave()` writes nothing unless something called `saveState()` first.**
A fixture that mutates `state` directly and then flushes saves nothing at all.

**Compare decoded pixels, not inflated PNG bytes.** Each PNG row stores deltas
against its neighbours under a filter the encoder picks per row, and chromium
does not always pick the same one for the same image. Comparing the inflated
stream reports differences that are not there. `harness.pngPixels()` reverses
the filters.

**An element screenshot captures whatever overlaps the element.** The HUD sits
on top of the map, and `#game-version` changes on every ship by house rule -
left visible it makes the pixel diff report a difference for every change ever
made. `pixel-diff.js` hides the HUD; the regression suite covers its text.

**Aborted tile requests log `ERR_FAILED`.** Expected noise, already filtered
by the harness.
