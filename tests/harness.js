// Shared harness for Bloom's Playwright suites.
//
// Bloom has no build step and no CI - these scripts are the only thing
// standing between a change and production. Everything here exists because
// driving the real index.html headlessly needs a few specific
// accommodations; see the bloom-playtest skill for the reasoning behind each.
//
// Nothing in here asserts anything. Each suite (regression.js, perf.js,
// zoom.js, pixel-diff.js) builds on this.

const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

const REPO_ROOT = path.resolve(__dirname, '..');
const GAME = path.join(REPO_ROOT, 'index.html');
const VENDOR = path.join(__dirname, 'vendor');
const CHROMIUM = '/opt/pw-browsers/chromium'; // a symlink to the executable itself, not a directory

// Somewhere real and unremarkable. Latitude matters: onGpsLocked derives
// CELL_LNG_DEG from it, so every fixture's tile coordinates depend on this
// staying fixed across runs.
const LAT = 37.7749, LNG = -122.4194;

function requireVendor() {
  for (const f of ['leaflet.min.js', 'leaflet.min.css']) {
    if (!fs.existsSync(path.join(VENDOR, f))) {
      console.error('Missing tests/vendor/' + f + ' - run tests/setup.sh first.');
      process.exit(2);
    }
  }
}

async function launch() {
  requireVendor();
  const { chromium } = require('playwright-core');
  return chromium.launch({ executablePath: CHROMIUM });
}

// Opens a Bloom build with Leaflet served locally and map tiles blocked, and
// with geolocation stubbed to a fixed position. Collects page/console errors
// into the returned `errors` array - aborted tile requests show up as
// ERR_FAILED and are expected noise, so they are filtered out here rather
// than by every caller.
//
// `file` defaults to the working copy. Pass a path from
// `git show HEAD:index.html > /tmp/old-index.html` to A/B against the
// shipped build.
async function openBloom(browser, opts) {
  opts = opts || {};
  const errors = [];
  const page = await browser.newPage({
    viewport: opts.viewport || { width: 420, height: 900 },
    reducedMotion: opts.reducedMotion // 'reduce' freezes ambient animation on both sides of a pixel diff
  });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('ERR_FAILED')) errors.push('CONSOLE: ' + m.text());
  });

  const cdn = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  await page.route(cdn + 'leaflet.min.js', (r) => r.fulfill({ path: path.join(VENDOR, 'leaflet.min.js') }));
  await page.route(cdn + 'leaflet.min.css', (r) => r.fulfill({ path: path.join(VENDOR, 'leaflet.min.css') }));
  await page.route('https://*.tile.openstreetmap.org/**', (r) => r.abort());
  await page.route('https://*/**tile**', (r) => r.abort());

  await page.addInitScript(([lat, lng]) => {
    navigator.geolocation = {
      getCurrentPosition: (ok) => setTimeout(() => ok({ coords: { latitude: lat, longitude: lng, accuracy: 5 } }), 0),
      watchPosition: () => 1,
      clearWatch: () => {}
    };
  }, [LAT, LNG]);

  // Resolved rather than used as given: a relative path silently produces
  // file://tests/out/foo.html, which chromium rejects as an invalid URL
  // rather than treating as relative to anything useful.
  await page.goto('file://' + path.resolve(opts.file || GAME));
  await page.waitForTimeout(opts.settle || 1000);
  return { page, errors };
}

// Force the GPS lock before building ANY fixture.
//
// onGpsLocked rewrites the global CELL_LNG_DEG to correct for the player's
// latitude, and q/r are lat/lng divided by that constant - so a fixture built
// beforehand is indexed against the uncorrected value and every tile of it
// lands ~26% further out than anything computed after. The failure is silent:
// state.plants looks perfect and renderPlants() builds zero markers because
// viewportCellBounds() returns a q range nowhere near the fixture's.
//
// It does not happen on its own either: a brand-new save has
// gpsPrimerSeen false, so the primer modal opens and requestLocation() is
// never called. Two calls - the first creates rangeArea and triggers
// onGpsLocked, the second runs against the corrected value.
async function lockGps(page, zoom) {
  await page.evaluate(([lat, lng, z]) => {
    onLocationUpdate({ coords: { latitude: lat, longitude: lng, accuracy: 5 } });
    onLocationUpdate({ coords: { latitude: lat, longitude: lng, accuracy: 5 } });
    map.setView([lat, lng], z, { animate: false });
    map.invalidateSize();
  }, [LAT, LNG, zoom || 18]);
  await page.waitForTimeout(250);
}

// ---- Fixtures ----------------------------------------------------------
// All of these run in the page and derive lat/lng from cellCenter(q, r),
// never the reverse - the grid has no origin offset, so q/r ARE lat/lng
// divided by cell size, and a hand-built pair that disagrees puts a marker
// and its own geometry in two different places with no error.
// Randomness is seeded so runs are comparable across builds.

function seededRandom(seed) {
  return function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
}

// ~1500 plants scattered over a +/-120-tile "city" with a few dozen near the
// player, plus a long walk's worth of visited tiles. This is the shape that
// exercises the cost-scales-with-save-size paths: saveState, updateHUD,
// tickPlants.
const LIFETIME_SAVE = function (arg) {
  var n = arg.plants, rnd = arg.rnd, here = latLngToCell(arg.lat, arg.lng), now = Date.now();
  var seed = 12345;
  var rand = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  state.plants = {}; state.wild = {}; state.weeds = {}; state.visited = {}; state.todayAccessible = {};
  var placed = 0, guard = 0;
  while (placed < n && guard++ < 200000) {
    var q, r;
    if (placed < 40) { q = here.q + Math.floor(rand() * 9) - 4; r = here.r + Math.floor(rand() * 9) - 4; }
    else { q = here.q + Math.floor(rand() * 240) - 120; r = here.r + Math.floor(rand() * 240) - 120; }
    var k = cellKey(q, r);
    if (state.plants[k]) continue;
    var c = cellCenter(q, r), sp = SPECIES[Math.floor(rand() * SPECIES.length)].key;
    state.plants[k] = {
      q: q, r: r, lat: c.lat, lng: c.lng, species: sp, color: baseColorOf(sp),
      stage: Math.floor(rand() * 4), plantedAt: now - Math.floor(rand() * 8.64e7),
      lastWateredAt: now - Math.floor(rand() * 3.6e6), readyAt: now - Math.floor(rand() * 3.6e6)
    };
    placed++;
  }
  for (var i = 0; i < 6000; i++) {
    state.visited[cellKey(here.q + Math.floor(rand() * 240) - 120, here.r + Math.floor(rand() * 240) - 120)] = 1;
  }
  state.todayAccessibleDay = localDayKey();
  for (var j = 0; j < 900; j++) {
    state.todayAccessible[cellKey(here.q + Math.floor(rand() * 60) - 30, here.r + Math.floor(rand() * 60) - 30)] = 1;
  }
  state.seeds = {};
  SPECIES.forEach(function (s) { state.seeds[s.key + ':' + baseColorOf(s.key)] = 20; });
  tickPlants();
  renderPlants(); renderWild(); renderSprinklers(); renderWeeds();
  return { plants: Object.keys(state.plants).length };
};

// Every tile on screen planted. Deliberately a PLAUSIBLE save, not a
// pathological one - a player filling in their own neighbourhood over months
// arrives here, and this is the density the per-frame paths have to survive.
const DENSE_VIEWPORT = function (arg) {
  var here = latLngToCell(arg.lat, arg.lng), now = Date.now();
  var seed = arg.seed || 999;
  var rand = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  state.plants = {}; state.wild = {}; state.weeds = {};
  for (var dq = -arg.halfQ; dq <= arg.halfQ; dq++) {
    for (var dr = -arg.halfR; dr <= arg.halfR; dr++) {
      if (arg.density && rand() > arg.density) continue;
      var q = here.q + dq, r = here.r + dr, c = cellCenter(q, r);
      var sp = SPECIES[Math.floor(rand() * SPECIES.length)].key;
      state.plants[cellKey(q, r)] = {
        q: q, r: r, lat: c.lat, lng: c.lng, species: sp, color: baseColorOf(sp),
        stage: 1 + Math.floor(rand() * 3), plantedAt: now, lastWateredAt: now, readyAt: now + 1e9
      };
    }
  }
  renderPlants();
  return { plants: Object.keys(state.plants).length };
};

// Everything visually load-bearing in one frame: the grid mesh, the
// today-access fill, markers across several species and stages, a rain rune
// and a grow rune with their full boundary geometry. One pixel comparison of
// this covers the lot.
const SHOWCASE = function (arg) {
  var here = latLngToCell(arg.lat, arg.lng), now = Date.now();
  var seed = 4242;
  var rand = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  state.plants = {}; state.wild = {}; state.weeds = {}; state.sprinklers = {};
  for (var dq = -5; dq <= 5; dq++) {
    for (var dr = -12; dr <= 12; dr++) {
      if (rand() > 0.55) continue;
      var q = here.q + dq, r = here.r + dr, c = cellCenter(q, r);
      var sp = SPECIES[Math.floor(rand() * SPECIES.length)].key;
      state.plants[cellKey(q, r)] = {
        q: q, r: r, lat: c.lat, lng: c.lng, species: sp, color: baseColorOf(sp),
        stage: 1 + Math.floor(rand() * 3), plantedAt: now, lastWateredAt: now, readyAt: now + 1e9
      };
    }
  }
  var rc = cellCenter(here.q - 3, here.r - 6);
  rainRings = {};
  rainRings[cellKey(here.q - 3, here.r - 6)] = { q: here.q - 3, r: here.r - 6, lat: rc.lat, lng: rc.lng };
  state.growRunes = {};
  state.growRunes[cellKey(here.q + 2, here.r + 5)] = {
    q: here.q + 2, r: here.r + 5, activatedAt: now, species: SPECIES[0].key, color: baseColorOf(SPECIES[0].key)
  };
  state.todayAccessibleDay = localDayKey(); state.todayAccessible = {};
  for (var aq = -6; aq <= 6; aq++) {
    for (var ar = -8; ar <= 8; ar++) state.todayAccessible[cellKey(here.q + aq, here.r + ar)] = 1;
  }
  tickPlants(); renderGridMesh(); renderPlants(); renderRainRings(); renderGrowRunes();
  return { plants: Object.keys(state.plants).length };
};

const fixtures = {
  lifetimeSave: (page, plants) => page.evaluate(LIFETIME_SAVE, { plants: plants || 1500, lat: LAT, lng: LNG }),
  denseViewport: (page, o) => page.evaluate(DENSE_VIEWPORT,
    Object.assign({ lat: LAT, lng: LNG, halfQ: 6, halfR: 13 }, o || {})),
  showcase: (page) => page.evaluate(SHOWCASE, { lat: LAT, lng: LNG })
};

// ---- Measurement -------------------------------------------------------

// Real frame deltas, which is what "choppy" actually means. A mean hides the
// thing being complained about, so callers should lead with longFrames.
async function sampleFrames(page, count) {
  const raw = await page.evaluate((n) => new Promise((resolve) => {
    var d = [], last = performance.now(), i = 0;
    function tick(t) { d.push(t - last); last = t; if (++i < n) requestAnimationFrame(tick); else resolve(d); }
    requestAnimationFrame(tick);
  }), count || 140);
  const s = raw.slice(10).sort((a, b) => a - b); // drop warm-up frames
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    longFrames: s.filter((x) => x > 20).length,
    sampled: s.length
  };
}

// Actual decoded pixels - inflated AND un-filtered.
//
// Comparing file bytes is obviously wrong (PNG is compressed), but comparing
// the merely INFLATED stream is wrong too, and much more convincingly: each
// PNG row carries a filter byte and its bytes are stored as deltas against
// the row above or the pixel to the left. Which filter the encoder picks per
// row is its own choice, and chromium does not always make the same one for
// the same image - so two screenshots of genuinely identical pixels compared
// this way came back "different by 36 bytes" on roughly a third of runs.
// That is a false alarm, and a false alarm sends you hunting a rendering bug
// that does not exist.
//
// Reversing the filters gives the real thing. The error only ever ran one
// way (identical pixels reported as different, never the reverse), so it
// could not have hidden a regression - but it could and did manufacture one.
function pngPixels(file) {
  const d = fs.readFileSync(file);
  let i = 8, idat = [], w = 0, hgt = 0, colorType = 6;
  while (i < d.length) {
    const len = d.readUInt32BE(i), type = d.toString('ascii', i + 4, i + 8);
    if (type === 'IHDR') { w = d.readUInt32BE(i + 8); hgt = d.readUInt32BE(i + 12); colorType = d[i + 17]; }
    else if (type === 'IDAT') idat.push(d.slice(i + 8, i + 8 + len));
    i += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const stride = w * bpp;
  const out = Buffer.alloc(stride * hgt);
  let pos = 0;
  for (let y = 0; y < hgt; y++) {
    const filter = raw[pos++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : null;
    raw.copy(row, 0, pos, pos + stride);
    pos += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prev ? prev[x] : 0;
      const c = (prev && x >= bpp) ? prev[x - bpp] : 0;
      if (filter === 1) row[x] = (row[x] + a) & 255;
      else if (filter === 2) row[x] = (row[x] + b) & 255;
      else if (filter === 3) row[x] = (row[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
  }
  return { hdr: { w: w, h: hgt, bpp: bpp }, pixels: out };
}

// Where two decoded images actually differ - a bounding box is far more use
// than a byte count when deciding whether a difference is a real regression
// or something incidental at the edge of the frame.
function diffRegion(a, b) {
  const { w, bpp } = a.hdr;
  let n = 0, maxDelta = 0, minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let i = 0; i < a.pixels.length; i += bpp) {
    let same = true;
    for (let k = 0; k < bpp; k++) {
      const d = Math.abs(a.pixels[i + k] - b.pixels[i + k]);
      if (d) { same = false; if (d > maxDelta) maxDelta = d; }
    }
    if (same) continue;
    n++;
    const px = i / bpp, x = px % w, y = (px / w) | 0;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { pixels: n, maxDelta: maxDelta, box: n ? { minX, minY, maxX, maxY } : null };
}

// A tolerance, kept as insurance rather than because it is currently needed.
//
// Chasing run-to-run screenshot variance during this harness's development
// went through two false explanations before the real one: comparing merely
// INFLATED png bytes rather than decoded pixels (fixed in pngPixels above),
// and then ~9 pixels that turned out to be HUD text antialiasing, since an
// element screenshot captures whatever overlaps the element - fixed at
// source by hiding the HUD (see pixel-diff.js). With both dealt with, the
// comparison is currently exact, run after run.
//
// This stays because rasterizer output is not contractually bit-exact
// across chromium versions or machines, and the alternative to an explicit,
// printed noise floor is a suite that someone eventually learns to ignore.
// Both numbers are always printed so the judgement can be checked rather
// than trusted. The two axes are chosen so nothing real can hide under
// them: a genuine rendering change either moves or recolours something
// (large channel deltas) or covers a real area of the frame (many pixels).
// Measured for calibration: the subtlest real change that could be
// constructed - the grid mesh's line alpha from 0.14 to 0.20, barely
// perceptible by eye - lit up 21,372 pixels, three orders of magnitude above
// this floor.
// 4: the run-to-run disagreement seen while building this peaked at 3 on an
// 8-bit channel, about 1% of range and well under a just-noticeable
// difference. To slip through, a change would have to be BOTH imperceptible
// in magnitude and confined to under ~190 pixels.
const NOISE_MAX_DELTA = 4;
const NOISE_MAX_FRACTION = 0.0005; // 0.05% of the frame - ~190px at 420x900
function isRasterNoise(diff, totalPixels) {
  return diff.pixels > 0 &&
    diff.maxDelta <= NOISE_MAX_DELTA &&
    diff.pixels <= totalPixels * NOISE_MAX_FRACTION;
}

// ---- Tiny reporter -----------------------------------------------------

function reporter() {
  let pass = 0, fail = 0;
  return {
    section: (name, note) => console.log('\n-- ' + name + ' --' + (note ? ' ' + note : '')),
    check: (name, ok, detail) => {
      if (ok) { pass++; console.log('  PASS  ' + name); }
      else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
    },
    done: (label) => {
      console.log('\n[' + label + '] ' + pass + ' passed, ' + fail + ' failed');
      return fail;
    }
  };
}

module.exports = {
  REPO_ROOT, GAME, LAT, LNG,
  launch, openBloom, lockGps, fixtures, sampleFrames, pngPixels, diffRegion, isRasterNoise, reporter, seededRandom
};
