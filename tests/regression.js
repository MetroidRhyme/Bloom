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

  // The grid mesh's todayAccessible fill (GitHub issue #20 follow-up - grass
  // over anywhere the player has walked and still has control of, not just
  // the live range ring) places a deterministic 4-5 tufts per real tile via
  // grassTuftPick, seeded off q,r - not a repeating fixed-pixel pattern.
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

  r.section('console cleanliness');
  r.check('no page or console errors', errors.length === 0, errors.slice(0, 5));

  const failed = r.done(target);
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
