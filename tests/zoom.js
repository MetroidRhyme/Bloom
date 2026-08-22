// Marker icon sizing across zoom levels.
//
//   node tests/zoom.js [path/to/index.html]
//
// This is the invariant most easily broken by touching render batching, and
// it fails silently. Every plantIconBase()-sized divIcon shares one
// _iconBuiltPx, which rescalePlantIcons() uses as the baseline for its live
// in-gesture CSS transform. A marker type left out of scheduleMarkerRender's
// batch gets that transform applied against a baseline some OTHER marker
// type just moved, so it drifts to the wrong size with every zoom step. That
// shipped for real once (the grow rune), and looked like "random sizes when
// zooming" with nothing obviously wrong in the diff that caused it.
//
// The walk is deliberately non-monotonic, and each step waits on a real
// zoomend rather than a fixed sleep: setZoom() is a no-op if the map is
// already at that level (so zoomend never fires), and the map's own
// min/maxZoom can silently clamp the request - hence reading getZoom() back
// instead of trusting the value asked for.

const h = require('./harness');

(async () => {
  const target = process.argv[2] || h.GAME;
  const browser = await h.launch();
  const { page, errors } = await h.openBloom(browser, { file: target });
  const r = h.reporter();

  await h.lockGps(page);
  await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng), now = Date.now();
    state.plants = {};
    for (var i = -3; i <= 3; i++) {
      var q = here.q, rr = here.r + i, c = cellCenter(q, rr);
      state.plants[cellKey(q, rr)] = {
        q: q, r: rr, lat: c.lat, lng: c.lng, species: SPECIES[0].key, color: baseColorOf(SPECIES[0].key),
        stage: 2, plantedAt: now, lastWateredAt: now, readyAt: now + 1e9
      };
    }
    var rc = cellCenter(here.q, here.r - 1);
    rainRings = {}; rainRings[cellKey(here.q, here.r - 1)] = { q: here.q, r: here.r - 1, lat: rc.lat, lng: rc.lng };
    // Watered (not just structurally complete) so the rain-effect marker
    // (see rainRuneStage/buildRainEffectSVG) actually exists to check -
    // its own plantIconBase()-derived sizing is a second marker type layered
    // on the same ring, the exact shape of thing this whole walk exists to
    // catch if it's left out of the zoom-rescale batch.
    state.runeWater = {}; state.runeWater[cellKey(here.q, here.r - 1)] = now;
    state.growRunes = {};
    state.growRunes[cellKey(here.q, here.r + 1)] = {
      q: here.q, r: here.r + 1, activatedAt: now, species: SPECIES[0].key, color: baseColorOf(SPECIES[0].key)
    };
    renderPlants(); renderRainRings(); renderGrowRunes();
  });
  await page.waitForTimeout(500);

  r.section('icon size tracks zoom (non-monotonic walk)');
  for (const z of [17, 19, 16, 18, 15, 19]) {
    const out = await page.evaluate((zoom) => new Promise((resolve) => {
      function done() {
        setTimeout(function () {
          function svgOf(m) {
            var el = m && m.getElement();
            return el ? el.querySelector('svg') : null;
          }
          var pk = Object.keys(plantMarkers)[0];
          var el = plantMarkers[pk].getElement();
          var plant = svgOf(plantMarkers[pk]);
          var rk = Object.keys(rainRingLayers)[0], gk = Object.keys(growRuneLayers)[0];
          var rune = rk ? svgOf(rainRingLayers[rk].marker) : null;
          var grow = gk ? svgOf(growRuneLayers[gk].marker) : null;
          var rain = (rk && rainRingLayers[rk].rain) ? svgOf(rainRingLayers[rk].rain) : null;
          resolve({
            zoom: map.getZoom(),
            expected: plantIconBase(),
            runeExpected: Math.round(plantIconBase() * 0.92),
            rainExpected: Math.round(plantIconBase() * (RAIN_RING_RADIUS * 2 + 1)),
            plantW: plant ? +plant.getAttribute('width') : null,
            runeW: rune ? +rune.getAttribute('width') : null,
            growW: grow ? +grow.getAttribute('width') : null,
            rainW: rain ? +rain.getAttribute('width') : null,
            // zoomend hands back fresh untransformed DOM, so the live
            // in-gesture scale must have fallen back to identity by now.
            leftoverTransform: el.firstElementChild ? (el.firstElementChild.style.transform || '') : ''
          });
        }, 350);
      }
      if (map.getZoom() === zoom) { done(); return; }
      map.once('zoomend', done);
      map.setZoom(zoom, { animate: false });
    }), z);

    const ok = out.plantW === out.expected &&
      out.leftoverTransform === '' &&
      (out.runeW === null || out.runeW === out.runeExpected) &&
      (out.growW === null || out.growW === out.runeExpected) &&
      (out.rainW === null || out.rainW === out.rainExpected);
    r.check('zoom ' + out.zoom + ': plant/rain/grow/rain-effect icons at true size, no leftover scale', ok, out);
  }

  r.section('console cleanliness');
  r.check('no page or console errors', errors.length === 0, errors.slice(0, 5));
  const failed = r.done(target);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
