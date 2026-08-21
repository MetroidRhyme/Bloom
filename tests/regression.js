// Bloom regression suite. Drives the real index.html in headless chromium.
//
//   node tests/regression.js                    # the working copy
//   node tests/regression.js /tmp/old-index.html  # A/B against another build
//
// Running it against `git show HEAD:index.html > /tmp/old-index.html` as well
// as the working copy is the fastest way to tell "my change broke this" from
// "this was already broken, or my test is wrong" - and it is often the
// latter. The expected shape of a good result: the working copy passes
// everything, and the older build fails ONLY the checks covering what you
// deliberately changed.
//
// Checks that cover code a given build may not have are guarded rather than
// failed, so one script runs against both sides of a comparison.

const h = require('./harness');

(async () => {
  const target = process.argv[2] || h.GAME;
  const browser = await h.launch();
  const { page, errors } = await h.openBloom(browser, { file: target });
  const r = h.reporter();
  let out;

  await h.lockGps(page);

  // ---- core loop -------------------------------------------------------
  r.section('core loop: plant / water / grow / harvest');
  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var q = here.q, rr = here.r + 1, key = cellKey(q, rr);
    delete state.plants[key];
    var vk = SPECIES[0].key + ':' + baseColorOf(SPECIES[0].key);
    state.seeds[vk] = 5;
    plantSeedAt(q, rr, vk);
    var planted = !!state.plants[key];
    // Route growth through the real waterPlant, not applyWatering: several
    // spell triggers are wired in at the call sites deliberately, and a
    // shortcut here silently skips them.
    var stages = [];
    for (var i = 0; i < 3 && state.plants[key]; i++) {
      state.plants[key].readyAt = Date.now() - 1;
      state.plants[key].lastWateredAt = Date.now() - WATER_DURATION_MS - 1;
      waterPlant(key);
      if (state.plants[key]) stages.push(state.plants[key].stage);
    }
    var maxed = state.plants[key] && state.plants[key].stage;
    var before = state.currency;
    harvestPlant(key, 'sell');
    return { planted: planted, stages: stages, maxed: maxed, gone: !state.plants[key], earned: state.currency - before };
  });
  r.check('plantSeedAt creates a plant', out.planted);
  r.check('watering advances stages 1 -> 2 -> 3', JSON.stringify(out.stages) === '[1,2,3]', out.stages);
  r.check('reaches MAX_STAGE', out.maxed === 3, out.maxed);
  r.check('harvest(sell) removes it and pays out', out.gone && out.earned > 0, out);

  // ---- save coalescing -------------------------------------------------
  const hasCoalescing = await page.evaluate(() => typeof writeSaveNow === 'function');
  r.section('save coalescing', hasCoalescing ? '' : '(SKIPPED - not in this build)');
  if (hasCoalescing) {
    out = await page.evaluate(async () => {
      localStorage.removeItem(STORAGE_KEY);
      state.currency = 4242;
      saveState();
      var immediate = localStorage.getItem(STORAGE_KEY);
      await new Promise((res) => setTimeout(res, 700));
      var landed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      var writes = 0, real = writeSaveNow;
      window.writeSaveNow = function () { writes++; return real.apply(null, arguments); };
      var t0 = performance.now();
      for (var i = 0; i < 200; i++) { state.currency = 5000 + i; saveState(); }
      var burstMs = performance.now() - t0;
      await new Promise((res) => setTimeout(res, 700));
      var afterBurst = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      window.writeSaveNow = real;
      return { deferred: immediate === null, currency: landed.currency, writes: writes,
               burstMs: +burstMs.toFixed(2), burstCurrency: afterBurst.currency };
    });
    r.check('saveState defers the write', out.deferred, out);
    r.check('the deferred write lands with the right data', out.currency === 4242, out);
    r.check('200 saves coalesce to at most 3 writes', out.writes <= 3, out);
    r.check('a burst of 200 saves costs under 20ms', out.burstMs < 20, out.burstMs);
    r.check('the last value in a burst is what persists', out.burstCurrency === 5199, out);

    out = await page.evaluate(() => {
      state.currency = 777; saveState();
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
      var after = JSON.parse(localStorage.getItem(STORAGE_KEY)).currency;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      return { after: after };
    });
    r.check('backgrounding force-flushes the pending save', out.after === 777, out);
  }

  // ---- reload round trip ----------------------------------------------
  r.section('reload round trip');
  await page.evaluate(() => {
    state.currency = 9191;
    state.plants = {};
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var c = cellCenter(here.q + 2, here.r);
    state.plants[cellKey(here.q + 2, here.r)] = {
      q: here.q + 2, r: here.r, lat: c.lat, lng: c.lng, species: SPECIES[1].key,
      color: baseColorOf(SPECIES[1].key), stage: 2, plantedAt: Date.now(),
      lastWateredAt: Date.now(), readyAt: Date.now() + 1e9
    };
    // saveState first: flushSave only writes when something marked it dirty,
    // so mutating state and flushing saves nothing at all.
    saveState();
    if (typeof flushSave === 'function') flushSave();
  });
  await page.reload();
  await page.waitForTimeout(1200);
  out = await page.evaluate(() => ({ currency: state.currency, plants: Object.keys(state.plants).length }));
  r.check('save survives a reload', out.currency === 9191 && out.plants === 1, out);
  await h.lockGps(page);

  // ---- rune viewport virtualization ------------------------------------
  r.section('rune viewport virtualization');
  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    rainRings = {};
    [[here.q, here.r], [here.q + 500, here.r + 500]].forEach(function (p) {
      var c = cellCenter(p[0], p[1]);
      rainRings[cellKey(p[0], p[1])] = { q: p[0], r: p[1], lat: c.lat, lng: c.lng };
    });
    state.growRunes = {};
    [[here.q, here.r + 3], [here.q + 500, here.r + 500]].forEach(function (p) {
      state.growRunes[cellKey(p[0], p[1])] = {
        q: p[0], r: p[1], activatedAt: Date.now(), species: SPECIES[0].key, color: baseColorOf(SPECIES[0].key)
      };
    });
    renderRainRings(); renderGrowRunes();
    return { rain: Object.keys(rainRingLayers).length, grow: Object.keys(growRuneLayers).length };
  });
  r.check('only the on-screen rain ring is built', out.rain === 1, out);
  r.check('only the on-screen grow rune is built', out.grow === 1, out);

  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var far = cellCenter(here.q + 500, here.r + 500);
    map.setView([far.lat, far.lng], 18, { animate: false });
    renderRainRings(); renderGrowRunes();
    return { rain: Object.keys(rainRingLayers).length, grow: Object.keys(growRuneLayers).length };
  });
  r.check('panning to the far rune builds it and tears down the near one', out.rain === 1 && out.grow === 1, out);

  // Bookkeeping has to run before the viewport filter, or off-screen runes
  // never expire and accumulate in the save forever.
  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var k = cellKey(here.q, here.r + 3);
    state.growRunes[k].activatedAt = Date.now() - GROW_RUNE_MS - 1000;
    renderGrowRunes();
    return { stillThere: !!state.growRunes[k] };
  });
  r.check('an off-screen expired grow rune is still pruned', !out.stillThere, out);
  await h.lockGps(page);

  // ---- ambient motion budget -------------------------------------------
  const hasBudget = await page.evaluate(() => typeof applyWindBudget === 'function');
  r.section('ambient motion budget', hasBudget ? '' : '(SKIPPED - not in this build)');
  if (hasBudget) {
    await h.fixtures.denseViewport(page, { halfQ: 6, halfR: 13 });
    await page.waitForTimeout(400);
    // Counted off the live markers rather than off a querySelectorAll of
    // '.no-wind': Leaflet can briefly leave a torn-down marker's element in
    // the DOM after a pan, and a raw DOM count picks those orphans up and
    // reports a budget that is one short. The invariant being tested is
    // "exactly N LIVE markers are allowed to animate", so count those.
    const budgetProbe = () => page.evaluate(() => {
      var dicts = [plantMarkers, wildMarkers, weedMarkers];
      var live = 0, still = 0;
      dicts.forEach(function (d) {
        Object.keys(d).forEach(function (k) {
          var el = d[k].getElement();
          if (!el) return; // built this frame, not laid out yet - not eligible either way
          live++;
          if (el.classList.contains('no-wind')) still++;
        });
      });
      var c = map.getSize().divideBy(2), best = null, bestD = Infinity;
      Object.keys(plantMarkers).forEach(function (k) {
        var pt = map.latLngToContainerPoint(plantMarkers[k].getLatLng());
        var dd = Math.pow(pt.x - c.x, 2) + Math.pow(pt.y - c.y, 2);
        if (dd < bestD) { bestD = dd; best = plantMarkers[k].getElement(); }
      });
      var g = best && best.querySelector('.wind-grass-back');
      return { live: live, moving: live - still, budget: WIND_ANIM_BUDGET,
               nearestAnimates: g ? getComputedStyle(g).animationName === 'windSway' : null };
    });
    out = await budgetProbe();
    r.check('a dense viewport really is over budget', out.live > out.budget, out);
    r.check('exactly the budget animates', out.moving === out.budget, out);
    r.check('the marker nearest screen centre is one of them', out.nearestAnimates === true, out);

    out = await page.evaluate(() => {
      map.fire('movestart');
      var during = document.body.classList.contains('map-moving');
      map.fire('moveend');
      return { during: during, after: document.body.classList.contains('map-moving') };
    });
    r.check('ambient motion pauses during a gesture and resumes after', out.during === true && out.after === false, out);

    // Re-ranking after a pan is what keeps the moving markers where the
    // player is looking rather than where they used to be.
    await page.evaluate(() => { map.panBy([0, 300], { animate: false }); map.fire('moveend'); });
    await page.waitForTimeout(500);
    out = await budgetProbe();
    r.check('the budget still holds after a pan', out.moving === out.budget, out);
    r.check('the re-ranked set is still centred on the screen', out.nearestAnimates === true, out);
  }

  // ---- HUD and toggles -------------------------------------------------
  r.section('HUD and toggles');
  await h.lockGps(page);
  out = await page.evaluate(() => {
    state.plants = {}; state.wild = {};
    updateHUD();
    var empty = document.getElementById('hud-status-line').innerHTML;
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    for (var i = 0; i < 3; i++) {
      var q = here.q, rr = here.r + i, c = cellCenter(q, rr);
      state.plants[cellKey(q, rr)] = {
        q: q, r: rr, lat: c.lat, lng: c.lng, species: SPECIES[0].key, color: baseColorOf(SPECIES[0].key),
        stage: 2, plantedAt: Date.now(), lastWateredAt: Date.now(), readyAt: Date.now() + 1e9
      };
    }
    tickPlants(); updateHUD();
    var three = document.getElementById('hud-status-line').innerHTML;
    Object.keys(state.plants).forEach(function (k) { state.plants[k].readyAt = Date.now() - 1; });
    tickPlants(); updateHUD();
    var ready = document.getElementById('hud-status-line').innerHTML;
    var vk = SPECIES[0].key + ':' + baseColorOf(SPECIES[0].key);
    state.seeds = {}; state.seeds[vk] = 7; updateHUD();
    var badge7 = document.getElementById('seed-toggle').textContent;
    state.seeds[vk] = 2; updateHUD();
    var badge2 = document.getElementById('seed-toggle').textContent;
    state.sprinklerInventory = 3; updateHUD();
    return { empty: empty, three: three, ready: ready, badge7: badge7, badge2: badge2,
             spr: document.getElementById('sprinkler-toggle').textContent };
  });
  r.check('empty-garden line', /plant your first seed/.test(out.empty), out.empty);
  r.check('growing/bloom counts render', /3 growing/.test(out.three), out.three);
  r.check('ready flowers take over the line', /ready to grow/.test(out.ready), out.ready);
  // The toggles skip identical innerHTML writes, so a stale badge here means
  // the change-detection key missed something it should track.
  r.check('seed badge updates 7 -> 2', /7/.test(out.badge7) && /2/.test(out.badge2), out);
  r.check('sprinkler badge updates', /3/.test(out.spr), out.spr);

  r.section('plant cycle arrows');
  out = await page.evaluate(() => {
    var keys = Object.keys(state.plants);
    viewingKey = keys[0]; viewingWild = false; syncPlantCycleArrows();
    var many = document.getElementById('plant-cycle-next').classList.contains('show');
    state.plants = { one: state.plants[keys[0]] }; syncPlantCycleArrows();
    var one = document.getElementById('plant-cycle-next').classList.contains('show');
    viewingKey = null; syncPlantCycleArrows();
    return { many: many, one: one, none: document.getElementById('plant-cycle-next').classList.contains('show') };
  });
  r.check('arrows show with >1 plant, hide otherwise', out.many === true && out.one === false && out.none === false, out);

  // ---- GPS backoff -----------------------------------------------------
  const hasBackoff = await page.evaluate(() => typeof gpsPollInterval === 'function');
  r.section('GPS standing-still backoff', hasBackoff ? '' : '(SKIPPED - not in this build)');
  if (hasBackoff) {
    out = await page.evaluate(() => {
      var base = gpsPollInterval();
      _lastMovedAt = Date.now() - 3 * 60 * 1000;  var idle3 = gpsPollInterval();
      _lastMovedAt = Date.now() - 7 * 60 * 1000;  var idle7 = gpsPollInterval();
      _lastMovedAt = Date.now() - 60 * 60 * 1000; var idle60 = gpsPollInterval();
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      var afterTouch = gpsPollInterval();
      _lastMovedAt = Date.now() - 60 * 60 * 1000;
      noteGpsActivity(false);
      return { base: base, idle3: idle3, idle7: idle7, idle60: idle60,
               afterTouch: afterTouch, afterMove: gpsPollInterval() };
    });
    r.check('walking cadence is 5s', out.base === 5000, out);
    r.check('backs off while stationary (15s/30s/60s)', out.idle3 === 15000 && out.idle7 === 30000 && out.idle60 === 60000, out);
    r.check('a touch anywhere snaps back to 5s', out.afterTouch === 5000, out);
    r.check('a tile change snaps back to 5s', out.afterMove === 5000, out);
  }

  // ---- camera re-anchors on zoom while following ------------------------
  // A pinch/scroll/double-tap zoom is Leaflet's own built-in zoom-around-
  // center handling, and it doesn't round-trip exactly - the CRS project/
  // unproject math drifts the map's ground center by a small but real
  // amount on every zoom step, and it accumulates. Since the grass texture
  // covers the whole screen, that drift reads as "the grass moved" far
  // more obviously than it would on a few sparse markers. See the
  // map.on('zoomend', ...) handler right after map.on('dragstart', ...).
  const hasZoomAnchor = await page.evaluate(() => userCellQ !== null);
  r.section('camera re-anchors on zoom while following', hasZoomAnchor ? '' : '(SKIPPED - not in this build)');
  if (hasZoomAnchor) {
    out = await page.evaluate(() => {
      var c = cellCenter(userCellQ, userCellR);
      // A drifted center a real zoom-around-a-point could plausibly leave -
      // a fraction of a tile off in both directions.
      var drifted = [c.lat + CELL_LAT_DEG * 0.3, c.lng + CELL_LNG_DEG * 0.3];

      state.following = true;
      map.panTo(drifted, { animate: false });
      map.fire('zoomend');
      var afterFollowing = map.getCenter();

      state.following = false;
      map.panTo(drifted, { animate: false });
      map.fire('zoomend');
      var afterNotFollowing = map.getCenter();

      // Restore what the rest of the suite expects the camera to be doing.
      state.following = true;
      map.panTo([c.lat, c.lng], { animate: false });

      return {
        target: c, drifted: { lat: drifted[0], lng: drifted[1] },
        afterFollowing: { lat: afterFollowing.lat, lng: afterFollowing.lng },
        afterNotFollowing: { lat: afterNotFollowing.lat, lng: afterNotFollowing.lng }
      };
    });
    // A lat/lng -> pixel -> lat/lng round trip (exactly the imprecision
    // this fix exists to correct for) is never bit-exact, so "snapped
    // back" means much closer to the target than the drift was, not
    // exactly equal to it.
    var dist = function (a, b) { return Math.hypot(a.lat - b.lat, a.lng - b.lng); };
    var driftSize = dist(out.drifted, out.target);
    var snappedBack = dist(out.afterFollowing, out.target) < driftSize * 0.05;
    var stayedDrifted = dist(out.afterNotFollowing, out.drifted) < driftSize * 0.05;
    r.check('while following, a zoomend snaps the drifted center back onto the player', snappedBack, out);
    r.check("not following (player panned off to browse), a zoomend leaves the camera alone", stayedDrifted, out);
  }

  // ---- panels ----------------------------------------------------------
  r.section('panels open cleanly');
  out = await page.evaluate(() => {
    var o = {};
    var open = function (name, fn, id, close) {
      try { fn(); o[name] = document.getElementById(id).classList.contains('open'); close(); }
      catch (e) { o[name + 'Err'] = e.message; }
    };
    open('shop', openShop, 'shop-panel', closeShop);
    open('journal', openInventory, 'journal-panel', closeJournal);
    open('greenhouse', function () {
      state.greenhouseUnlocked = true;
      if (!state.greenhouse.pots.length) state.greenhouse.pots = buildInitialPots();
      openGreenhouse();
    }, 'greenhouse-panel', closeGreenhouse);
    var k = Object.keys(state.plants)[0];
    open('plant', function () { openPlantPanel(k); }, 'plant-panel', closePlantPanel);
    return o;
  });
  r.check('shop opens', out.shop === true, out);
  r.check('journal opens', out.journal === true, out);
  r.check('greenhouse opens', out.greenhouse === true, out);
  r.check('plant panel opens', out.plant === true, out);

  // ---- planting the last seed of a variant --------------------------------
  // The trailing native 'click' behind a pointer-resolved tap (see
  // suppressNextMapClick's own comment) used to fall through to "occupied
  // tile -> open its panel" specifically when the tap spent the LAST seed of
  // a variant, because unequipping cleared the guard the click handler
  // relies on before that click arrived. Exercises the real pointerup path
  // (onToolPointerUp), not a hand-set flag, so it actually proves the fix is
  // wired in rather than just that the fix exists somewhere.
  r.section('planting the last seed of a variant');
  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var q = here.q + 1, rr = here.r, key = cellKey(q, rr);
    delete state.plants[key];
    var c = cellCenter(q, rr);
    var vk = SPECIES[1].key + ':' + baseColorOf(SPECIES[1].key);
    state.seeds[vk] = 1; // exactly one - the case that used to break
    equipSeed(vk);
    pointerState = { id: 4242, x: 250, y: 250, cell: { q: q, r: rr }, target: null, moved: false, completed: false, mode: 'seed' };
    onToolPointerUp({ pointerId: 4242 });
    var afterTap = { planted: !!state.plants[key], seedsLeft: state.seeds[vk] || 0, equippedSeed: equippedSeed };
    // The trailing click Leaflet fires right behind that same tap.
    map.fire('click', { latlng: L.latLng(c.lat, c.lng) });
    return {
      afterTap: afterTap,
      panelOpen: document.getElementById('plant-panel').classList.contains('open'),
      viewingKey: viewingKey,
      key: key
    };
  });
  r.check('the last seed still plants', out.afterTap.planted, out);
  r.check('the seed is spent and unequipped', out.afterTap.seedsLeft === 0 && !out.afterTap.equippedSeed, out);
  r.check("the flower's panel does NOT open from the trailing click", !out.panelOpen, out);

  // ---- What's New ------------------------------------------------------
  r.section("What's New popup");
  out = await page.evaluate(() => {
    state.lastSeenVersion = 'v0.0.1';
    var opened = maybeShowWhatsNew();
    return { opened: opened, title: document.getElementById('modal-title').textContent,
             bullets: document.querySelectorAll('#modal-body li').length,
             version: document.getElementById('game-version').textContent };
  });
  // The live version must have its own CHANGELOG entry, or the popup shows
  // nothing for whatever just shipped - the single easiest step to forget.
  r.check('the live version has a changelog entry', out.opened === true && out.bullets > 0, out);
  r.check('the popup names the live version', out.title.indexOf(out.version) !== -1, out);

  // ---- sprinklers near magic (issue #19) ---------------------------------
  r.section('sprinklers near magic');
  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var base = { q: here.q + 40, r: here.r + 40 }; // well clear of the fixture's own plants
    var results = {};

    // Rain Ring: a single-tile rune ground at (base.q, base.r).
    rainRings = {};
    rainRings[cellKey(base.q, base.r)] = { q: base.q, r: base.r };
    results.rainInside = sprinklerNearMagic(base.q, base.r);
    results.rainAdjacent = sprinklerNearMagic(base.q + 1, base.r);
    results.rainFar = sprinklerNearMagic(base.q + 5, base.r);
    rainRings = {};

    // Grow Rune: a 2x2 footprint anchored at (base.q, base.r).
    state.growRunes = {};
    state.growRunes[cellKey(base.q, base.r)] = { q: base.q, r: base.r, activatedAt: Date.now() };
    results.growInside = sprinklerNearMagic(base.q + 1, base.r + 1); // opposite corner of the block
    results.growAdjacent = sprinklerNearMagic(base.q - 1, base.r);
    results.growFar = sprinklerNearMagic(base.q + 5, base.r);
    state.growRunes = {};

    // Loki's Control / Scry: a 4x4 zone rectangle.
    lokiZones = { z: { qMin: base.q, rMin: base.r, qMax: base.q + 3, rMax: base.r + 3 } };
    results.lokiInside = sprinklerNearMagic(base.q + 1, base.r + 1);
    results.lokiAdjacent = sprinklerNearMagic(base.q - 1, base.r);
    results.lokiFar = sprinklerNearMagic(base.q + 10, base.r);
    lokiZones = {};

    scryZones = { z: { qMin: base.q, rMin: base.r, qMax: base.q + 3, rMax: base.r + 3 } };
    results.scryInside = sprinklerNearMagic(base.q + 1, base.r + 1);
    results.scryAdjacent = sprinklerNearMagic(base.q + 4, base.r); // one tile past qMax
    results.scryFar = sprinklerNearMagic(base.q + 10, base.r);
    scryZones = {};

    return results;
  });
  r.check("inside a Rain Ring's rune ground counts as near magic", out.rainInside === true, out);
  r.check('adjacent to a Rain Ring counts as near magic', out.rainAdjacent === true, out);
  r.check('far from a Rain Ring does not', out.rainFar === false, out);
  r.check("inside a Grow Rune's 2x2 patch counts as near magic", out.growInside === true, out);
  r.check('adjacent to a Grow Rune counts as near magic', out.growAdjacent === true, out);
  r.check('far from a Grow Rune does not', out.growFar === false, out);
  r.check('inside a Loki zone counts as near magic', out.lokiInside === true, out);
  r.check('adjacent to a Loki zone counts as near magic', out.lokiAdjacent === true, out);
  r.check('far from a Loki zone does not', out.lokiFar === false, out);
  r.check('inside a Scry zone counts as near magic', out.scryInside === true, out);
  r.check('adjacent to a Scry zone counts as near magic', out.scryAdjacent === true, out);
  r.check('far from a Scry zone does not', out.scryFar === false, out);

  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var base = { q: here.q + 60, r: here.r + 60 };
    state.plants = {}; state.wild = {}; state.sprinklers = {};
    rainRings = {}; state.growRunes = {}; lokiZones = {}; scryZones = {};
    state.sprinklerInventory = 5;
    equippedSprinkler = true;

    // A Rain Ring's rune sits at base - placing a sprinkler right next to
    // it should be refused, with a toast naming why.
    rainRings[cellKey(base.q, base.r)] = { q: base.q, r: base.r };
    placeSprinklerAt(base.q + 1, base.r);
    var blocked = !state.sprinklers[cellKey(base.q + 1, base.r)] && state.sprinklerInventory === 5;
    var toasts = document.querySelectorAll('#toast-container .toast');
    var toastText = toasts.length ? toasts[toasts.length - 1].textContent : '';

    // Placing one well away from the rune still works normally.
    placeSprinklerAt(base.q + 10, base.r);
    var placedFar = !!state.sprinklers[cellKey(base.q + 10, base.r)] && state.sprinklerInventory === 4;

    return { blocked: blocked, toastMentionsMagic: /magic/i.test(toastText), placedFar: placedFar };
  });
  r.check('placing a sprinkler adjacent to a Rain Ring is refused', out.blocked === true, out);
  r.check('the refusal toast mentions magic', out.toastMentionsMagic === true, out);
  r.check('placing a sprinkler away from any spell still works', out.placedFar === true, out);

  out = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var base = { q: here.q + 80, r: here.r + 80 };
    state.plants = {}; state.wild = {}; state.sprinklers = {};
    rainRings = {}; state.growRunes = {}; lokiZones = {}; scryZones = {};
    autoWaterAnimKeys = {}; sprinklerBrokenState = {};

    function thirstyPlantAt(q, r) {
      var c = cellCenter(q, r);
      return { q: q, r: r, lat: c.lat, lng: c.lng, species: SPECIES[0].key,
        color: baseColorOf(SPECIES[0].key), stage: 1, plantedAt: Date.now(),
        lastWateredAt: Date.now() - WATER_DURATION_MS - 1, readyAt: Date.now() - 1 };
    }
    function sprinklerAt(q, r) {
      var c = cellCenter(q, r);
      return { q: q, r: r, lat: c.lat, lng: c.lng, placedAt: Date.now() };
    }

    // A working sprinkler, far from any magic, beside a thirsty plant.
    state.sprinklers[cellKey(base.q, base.r)] = sprinklerAt(base.q, base.r);
    var plantKeyOk = cellKey(base.q + 1, base.r);
    state.plants[plantKeyOk] = thirstyPlantAt(base.q + 1, base.r);

    // A sprinkler placed next to a Rain Ring that formed after the fact -
    // broken - beside its own thirsty plant.
    var ringAt = { q: base.q + 20, r: base.r };
    rainRings[cellKey(ringAt.q, ringAt.r)] = { q: ringAt.q, r: ringAt.r };
    var brokenPos = { q: ringAt.q + 1, r: ringAt.r };
    state.sprinklers[cellKey(brokenPos.q, brokenPos.r)] = sprinklerAt(brokenPos.q, brokenPos.r);
    var plantKeyBroken = cellKey(brokenPos.q + 1, brokenPos.r);
    state.plants[plantKeyBroken] = thirstyPlantAt(brokenPos.q + 1, brokenPos.r);

    tickSprinklers();

    return {
      workingWatered: !!autoWaterAnimKeys[plantKeyOk],
      brokenNotWatered: !autoWaterAnimKeys[plantKeyBroken],
      brokenFlagged: sprinklerBrokenState[cellKey(brokenPos.q, brokenPos.r)] === true,
      // Only a state FLIP ever gets written (see tickSprinklers) - a
      // sprinkler that was never near magic just never earns an entry, so
      // "unflagged" means falsy, not strictly false.
      workingFlagged: !sprinklerBrokenState[cellKey(base.q, base.r)]
    };
  });
  r.check('a sprinkler far from magic still waters a thirsty neighbor', out.workingWatered === true, out);
  r.check('a sprinkler next to a Rain Ring does not water its neighbor', out.brokenNotWatered === true, out);
  r.check('tickSprinklers flags the broken one', out.brokenFlagged === true, out);
  r.check('tickSprinklers leaves the working one unflagged', out.workingFlagged === true, out);

  // ---- Spell Book progressive unlock --------------------------------------
  const hasSpellbookUnlock = await page.evaluate(() => typeof isRainRingUnlocked === 'function');
  r.section('Spell Book progressive unlock', hasSpellbookUnlock ? '' : '(SKIPPED - not in this build)');
  if (hasSpellbookUnlock) {
    out = await page.evaluate(() => {
      // Nothing discovered, Cheat Mode off: menu hidden, every card locked.
      state.inventory = {};
      state.cheatMode = false;
      syncSpellbookUnlockUI();
      renderSpellbookPage();
      var lockedNone = document.querySelectorAll('.spell-card.locked').length;
      var unlockedNone = document.querySelectorAll('.spell-card:not(.locked)').length;
      var menuHiddenAtStart = !document.body.classList.contains('spellbook-unlocked');

      // Cheat Mode alone shows the menu without faking any individual
      // spell's own unlock - it's a visibility shortcut, not a cheat on
      // the predicates themselves.
      state.cheatMode = true;
      syncSpellbookUnlockUI();
      var menuShownUnderCheat = document.body.classList.contains('spellbook-unlocked');
      var stillNoneUnlocked = !anySpellUnlocked();
      state.cheatMode = false;
      syncSpellbookUnlockUI();
      var menuHiddenAgain = !document.body.classList.contains('spellbook-unlocked');

      // Discover every species as Blue -> only the Rain Ring's card unlocks.
      SPECIES.forEach(function (s) { recordGrown(s.key + ':blue'); });
      renderSpellbookPage();
      var lockedAfter = document.querySelectorAll('.spell-card.locked').length;
      var unlockedAfter = document.querySelectorAll('.spell-card:not(.locked)').length;
      var menuShownAfterDiscovery = document.body.classList.contains('spellbook-unlocked');
      var lockedCardsMentionHint = Array.prototype.every.call(
        document.querySelectorAll('.spell-card.locked p'), function (p) { return p.textContent.length > 0; });

      return {
        lockedNone: lockedNone, unlockedNone: unlockedNone, menuHiddenAtStart: menuHiddenAtStart,
        menuShownUnderCheat: menuShownUnderCheat, stillNoneUnlocked: stillNoneUnlocked, menuHiddenAgain: menuHiddenAgain,
        lockedAfter: lockedAfter, unlockedAfter: unlockedAfter, menuShownAfterDiscovery: menuShownAfterDiscovery,
        lockedCardsMentionHint: lockedCardsMentionHint,
        rainUnlocked: isRainRingUnlocked(), growUnlocked: isGrowSpellUnlocked(),
        lokiUnlocked: isLokiUnlocked(), scryUnlocked: isScryUnlocked()
      };
    });
    r.check('nothing discovered -> all four cards locked', out.lockedNone === 4 && out.unlockedNone === 0, out);
    r.check('nothing discovered -> menu entry hidden', out.menuHiddenAtStart === true, out);
    r.check('Cheat Mode alone reveals the menu entry', out.menuShownUnderCheat === true, out);
    r.check("...without unlocking any spell's own predicate", out.stillNoneUnlocked === true, out);
    r.check('turning Cheat Mode back off (nothing unlocked) hides it again', out.menuHiddenAgain === true, out);
    r.check('every species discovered as Blue -> Rain Ring unlocks, the other three stay locked',
      out.rainUnlocked === true && out.growUnlocked === false && out.lokiUnlocked === false && out.scryUnlocked === false, out);
    r.check('the page reflects that: 1 unlocked card, 3 still locked',
      out.unlockedAfter === 1 && out.lockedAfter === 3, out);
    r.check('discovery alone (no Cheat Mode) reveals the menu entry', out.menuShownAfterDiscovery === true, out);
    r.check('every locked card still shows its own hint text', out.lockedCardsMentionHint === true, out);
  }

  // ---- Crossing Notes: structural recipe lines shown before discovery ----
  const hasRecipeEdges = await page.evaluate(() => typeof computeRecipeEdges === 'function');
  r.section('Crossing Notes recipe lines', hasRecipeEdges ? '' : '(SKIPPED - not in this build)');
  if (hasRecipeEdges) {
    out = await page.evaluate(() => {
      // Nothing crossed at all - every valid recipe should still produce an
      // edge (structural, not a result), and every edge should render as
      // .mystery (dashed) since nothing is discovered yet.
      state.crosses = {};
      var edgesEmpty = computeRecipeEdges('sunflower');
      var expectedCount = Object.keys(BREED_TABLE).length + Object.keys(SIGNATURE_TABLE).length;
      var allDifferFromParents = edgesEmpty.every(function (e) { return e.child !== e.a && e.child !== e.b; });

      // openCrossNotes/renderCrossTree schedule the actual edge drawing via
      // requestAnimationFrame (see drawTreeEdges's own comment - it needs a
      // layout pass before getBoundingClientRect is trustworthy), so call
      // it directly here rather than waiting a real frame in the test.
      openCrossNotes();
      drawTreeEdges();
      var svg = document.getElementById('tree-svg');
      var pathsEmpty = svg.querySelectorAll('path.tree-edge').length;
      var knownEmpty = svg.querySelectorAll('path.tree-edge.known').length;
      var mysteryEmpty = svg.querySelectorAll('path.tree-edge.mystery').length;

      // Discover exactly one recipe's result (red+white -> pink). Its own
      // two edges (red->pink, white->pink) should flip to .known; nothing
      // else should change count or flip style.
      var k = crossKey('red', 'white');
      state.crosses[k] = { pink: 1 };
      renderCrossTree('sunflower');
      drawTreeEdges();
      // renderCrossTree replaces #notes-body's innerHTML wholesale, so the
      // old `svg` reference is now a detached element - re-fetch it.
      svg = document.getElementById('tree-svg');
      var pathsAfter = svg.querySelectorAll('path.tree-edge').length;
      var knownAfter = svg.querySelectorAll('path.tree-edge.known').length;
      var pinkNode = document.querySelector('[data-color="pink"]');
      var greenNode = document.querySelector('[data-color="green"]'); // still undiscovered

      // Reordering (orderedTierColors) should never drop or duplicate a
      // color - just reorder tierColors(1)'s own 6 entries.
      var edges = computeRecipeEdges('sunflower');
      var t0 = tierColors(0).map(function (c) { return c.id; });
      var t1 = orderedTierColors(1, edges, t0);
      var t1Plain = tierColors(1).map(function (c) { return c.id; });
      var sameSet = t1.map(function (c) { return c.id; }).sort().join(',') === t1Plain.slice().sort().join(',');

      return {
        edgeCount: edgesEmpty.length, expectedCount: expectedCount, allDifferFromParents: allDifferFromParents,
        pathsEmpty: pathsEmpty, knownEmpty: knownEmpty, mysteryEmpty: mysteryEmpty,
        pathsAfter: pathsAfter, knownAfter: knownAfter,
        pinkIsSlot: pinkNode ? pinkNode.classList.contains('slot') && !pinkNode.classList.contains('blank') : false,
        greenIsBlank: greenNode ? greenNode.classList.contains('blank') : false,
        sameSet: sameSet, reordered: t1.map(function (c) { return c.id; }).join(',') !== t1Plain.join(',')
      };
    });
    r.check('every BREED_TABLE/SIGNATURE_TABLE recipe produces an edge, with nothing crossed yet',
      out.edgeCount === out.expectedCount, out);
    r.check("every edge's child differs from both its parents", out.allDifferFromParents === true, out);
    r.check('with nothing discovered, every edge renders but none are .known',
      out.pathsEmpty === out.expectedCount * 2 && out.knownEmpty === 0 && out.mysteryEmpty === out.pathsEmpty, out);
    r.check('discovering one recipe does not add or remove any line', out.pathsAfter === out.pathsEmpty, out);
    r.check('...it only flips that recipe\'s own 2 edges to .known', out.knownAfter === 2, out);
    r.check('the discovered color renders as a real slot, not blank', out.pinkIsSlot === true, out);
    r.check('an undiscovered color a line reaches still renders blank/"?"', out.greenIsBlank === true, out);
    r.check('orderedTierColors keeps the exact same set of colors', out.sameSet === true, out);
    r.check('...just reorders them to reduce crossing lines', out.reordered === true, out);
  }

  // ---- range shape grass texture (issue #20, grass-clutter fix) ----------
  r.section('range shape grass texture');
  out = await page.evaluate(() => ({
    fillsWithPattern: rangeArea.options.fillColor === 'url(#bloom-grass-pattern)',
    patternInDom: !!document.querySelector('#bloom-grass-pattern')
  }));
  r.check('the range shape fills with the grass pattern, not a flat color', out.fillsWithPattern === true, out);
  r.check('the grass pattern is actually in the SVG', out.patternInDom === true, out);

  // The pattern's tile is sized to the real on-screen width of one grid
  // square (cellPixelWidth), not a fixed pixel constant - that's the actual
  // fix: a fixed-pixel tile let more repeats fit into the same real square
  // the further in you zoomed, so the tuft count crept up with zoom. Also
  // confirm it still draws exactly four tufts (12 blade paths, 3 per tuft).
  out = await page.evaluate(() => {
    var pattern = document.querySelector('#bloom-grass-pattern');
    return {
      widthMatchesCell: Math.abs(parseFloat(pattern.getAttribute('width')) - cellPixelWidth()) < 0.5,
      fourTuftPaths: pattern.querySelectorAll('path').length === 12
    };
  });
  r.check('the pattern tile is sized to one real grid square', out.widthMatchesCell === true, out);
  r.check('the pattern draws exactly four tufts (12 blade paths)', out.fourTuftPaths === true, out);

  // Zoom to a different level and confirm the pattern resizes to track the
  // new on-screen square width, while the tuft count itself never moves -
  // this is the whole point: size can change with zoom, count can't.
  out = await page.evaluate(() => new Promise((resolve) => {
    var before = parseFloat(document.querySelector('#bloom-grass-pattern').getAttribute('width'));
    var targetZoom = map.getZoom() === 19 ? 16 : 19;
    function done() {
      setTimeout(function () {
        var pattern = document.querySelector('#bloom-grass-pattern');
        resolve({
          before: before,
          after: parseFloat(pattern.getAttribute('width')),
          stillFourTufts: pattern.querySelectorAll('path').length === 12
        });
      }, 200);
    }
    if (map.getZoom() === targetZoom) { done(); return; }
    map.once('zoomend', done);
    map.setZoom(targetZoom, { animate: false });
  }));
  r.check('the pattern tile resizes on zoom instead of the tuft count scaling', out.before !== out.after, out);
  r.check('tuft count is still exactly four after the zoom change', out.stillFourTufts === true, out);

  // grassTuftPick (the per-tile 4-5-tuft layout the grid mesh paints with)
  // is still deterministic and per-tile, independent of which cells the
  // mesh actually chooses to call it for.
  out = await page.evaluate(() => {
    var a = grassTuftPick(5, 9), b = grassTuftPick(5, 9), c = grassTuftPick(6, 9);
    var countOf = function (pick) { return pick.skip === -1 ? 5 : 4; };
    return {
      deterministic: JSON.stringify(a) === JSON.stringify(b),
      validCount: countOf(a) === 4 || countOf(a) === 5,
      differsByTile: JSON.stringify(a) !== JSON.stringify(c)
    };
  });
  r.check('grassTuftPick is deterministic per tile (stable across redraws)', out.deterministic === true, out);
  r.check('grassTuftPick always picks four or five tufts', out.validCount === true, out);
  r.check('grassTuftPick varies from one tile to the next', out.differsByTile === true, out);

  // ---- grid mesh grass tracks the whole day's walk, resets at midnight ---
  // Reported symptom (of the OPPOSITE kind from what shipped in v2.39.7):
  // ground the player had actually walked through earlier today - and which
  // still grants real plant/water/harvest access all day, per inRange() -
  // stopped reading as grass the moment they walked on, even though nothing
  // about their access to it had changed. The "memory" was real in state
  // (todayAccessible) but invisible on the map. Fix: renderGridMesh gates
  // each tile on the same inRange() every gameplay action already goes
  // through (live PLANT_RANGE/Scry/Loki OR anywhere walked within range
  // earlier today), not just the live-position half of it (liveControl) -
  // so grass always matches what's actually usable, and only shrinks back
  // at a real local-midnight rollover (state.todayAccessible resetting),
  // never just because the player moved on.
  r.section("grid mesh grass tracks the whole day's walk, resets at midnight");
  const settleRaf = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(function () { requestAnimationFrame(resolve); })));
  // The previous section leaves the map at whatever zoom its own resize
  // check last toggled to (18 or 19) - a higher zoom shows fewer real tiles
  // across the same 420px viewport, so a fixed tile offset calibrated for
  // one zoom can land outside the padded viewport at another and never get
  // reached by renderGridMesh's loop at all, independent of inRange(). Pin
  // it back to a known zoom rather than depend on what the last section
  // happened to leave behind.
  await page.evaluate(() => new Promise((resolve) => {
    if (map.getZoom() === 18) { resolve(); return; }
    map.once('zoomend', resolve);
    map.setZoom(18, { animate: false });
  }));
  // Alpha of the pixel at a cell's own screen center - 0 means renderGridMesh
  // painted nothing there, since ctx.clearRect leaves fully transparent
  // pixels and any grass fill/tuft stroke writes a non-zero alpha. Leaflet's
  // canvas renderer draws using world layer-point coordinates (it
  // ctx.translate()s the context to compensate), but getImageData reads raw
  // buffer pixels and ignores that transform - so a layer point has to be
  // converted into buffer space by hand: subtract the renderer's own bounds
  // origin, then scale by the canvas's actual pixel size over its logical
  // (CSS) size, which differs on a retina buffer.
  const cellPaintedAlpha = (dq, dr) => page.evaluate(([dq, dr]) => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var c = cellCenter(here.q + dq, here.r + dr);
    var p = map.latLngToLayerPoint([c.lat, c.lng]);
    var b = gridRenderer._bounds, canvas = gridRenderer._ctx.canvas;
    var scale = canvas.width / b.getSize().x;
    var x = Math.round((p.x - b.min.x) * scale), y = Math.round((p.y - b.min.y) * scale);
    return gridRenderer._ctx.getImageData(x, y, 1, 1).data[3];
  }, [dq, dr]);

  await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    for (var i = -6; i <= 6; i++) markAccessibleToday(here.q + i, here.r);
    scheduleGridRedraw();
  });
  await settleRaf();

  const farInRange = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    return inRange(here.q + 6, here.r); // outside live PLANT_RANGE, inside the walked strip above
  });
  const farAlpha = await cellPaintedAlpha(6, 0);
  const nearAlpha = await cellPaintedAlpha(1, 0); // inside live PLANT_RANGE

  r.check('a tile walked past earlier today counts as in range (real access)', farInRange === true, { farInRange });
  r.check('and that same tile DOES paint as grass, even though it is out of live range', farAlpha > 0, { farAlpha });
  r.check('a tile still inside live range also paints as grass', nearAlpha > 0, { nearAlpha });

  // A real local-midnight rollover - not just moving away - is what should
  // make the remembered strip stop reading as grass. Mirrors the "offline
  // catch-up on tab resume" handler's own scheduleGridRedraw call (see
  // v2.39.5) so the mesh actually repaints, the same way it would for a
  // player who backgrounded the tab overnight.
  await page.evaluate(() => { state.todayAccessibleDay = 'not-today'; scheduleGridRedraw(); });
  await settleRaf();

  const afterRolloverInRange = await page.evaluate(() => {
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    return inRange(here.q + 6, here.r);
  });
  const afterRolloverFarAlpha = await cellPaintedAlpha(6, 0);
  const afterRolloverNearAlpha = await cellPaintedAlpha(1, 0); // still live, unaffected by the rollover

  r.check('that access itself expires on a day rollover', afterRolloverInRange === false, { afterRolloverInRange });
  r.check('and the remembered tile stops painting as grass once it does', afterRolloverFarAlpha === 0, { afterRolloverFarAlpha });
  r.check('a tile still inside live range keeps painting through the rollover', afterRolloverNearAlpha > 0, { afterRolloverNearAlpha });

  // ---- grass tufts stay inside their own tile's row, not the row south ---
  // Reported symptom: a stray row of grass tufts printed just past the
  // bottom (south) edge of the live-control highlight, outside the green
  // range polygon entirely. Cause: drawGrassTufts's per-cell anchor used
  // the tile's BOTTOM screen edge as its (x, y) origin and then added a
  // positive (top-to-bottom) spot.y fraction of a tile width - pushing
  // every tuft up to a tile-height further south/down than its own cell,
  // which the wash rectangles masked everywhere except the live-control
  // area's southmost row, where the displaced tufts had no cell below to
  // land in and printed outside the highlight. Sampled at the excluded
  // tile's own center (well within where a south-shifted tuft would land)
  // rather than its edge, so this fails the same way the visual bug did.
  r.section('grass tufts do not bleed past the live-control boundary');
  const livePlantRange = await page.evaluate(() => PLANT_RANGE);
  const southOfRangeAlpha = await cellPaintedAlpha(0, -(livePlantRange + 1)); // one tile past the southmost live row
  const southmostInRangeAlpha = await cellPaintedAlpha(0, -livePlantRange);   // the southmost live row itself
  r.check('the tile just south of live range is not painted as grass', southOfRangeAlpha === 0, { southOfRangeAlpha });
  r.check('the southmost tile still inside live range does paint as grass', southmostInRangeAlpha > 0, { southmostInRangeAlpha });

  r.section('console cleanliness');
  r.check('no page or console errors', errors.length === 0, errors.slice(0, 5));

  const failed = r.done(target);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
