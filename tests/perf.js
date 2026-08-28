// Bloom profiling. Prints the numbers; asserts nothing.
//
//   node tests/perf.js                      # the working copy
//   node tests/perf.js /tmp/old-index.html  # compare against another build
//
// Read the bloom-perf skill for what these mean. The short version:
//
//  * "long frames" is the number that matches the complaint. A p50 of 16.7ms
//    with 40% of frames over 20ms is a real stutter that a mean would hide.
//  * The per-call table is the cost-scales-with-save-size risk. Anything on
//    the per-frame, per-GPS-fix or per-minute-tick path should do work
//    proportional to what changed, not to the size of the save.
//  * The budget sweep is how WIND_ANIM_BUDGET was chosen. Redo it rather
//    than guessing a new value - and note these are software-raster numbers,
//    so leave real margin for a mid-range phone.

const h = require('./harness');

function row(label, value, unit) {
  console.log('  ' + String(value).padStart(9) + ' ' + (unit || 'ms') + '   ' + label);
}

(async () => {
  const target = process.argv[2] || h.GAME;
  const browser = await h.launch();
  const { page, errors } = await h.openBloom(browser, { file: target });
  console.log('build: ' + target);

  await h.lockGps(page);
  const fixture = await h.fixtures.lifetimeSave(page);

  // ---- per-call costs on a realistic lifetime save ----------------------
  const scene = await page.evaluate(() => ({
    markers: Object.keys(plantMarkers).length,
    animated: document.querySelectorAll('.wind-grass-back,.wind-grass-front,.wind-stem').length,
    domNodes: document.getElementsByTagName('*').length,
    saveKB: +((JSON.stringify(localStorage.getItem(STORAGE_KEY) || '').length) / 1024).toFixed(1)
  }));
  console.log('\nlifetime save: ' + fixture.plants + ' plants | ' + scene.markers + ' visible markers | ' +
    scene.animated + ' animated SVG groups | ' + scene.domNodes + ' DOM nodes | ' + scene.saveKB + 'KB save');

  const calls = await page.evaluate(() => {
    function bench(label, fn, iters) {
      try { fn(); } catch (e) { return { label: label, ms: 'n/a' }; }
      var t0 = performance.now();
      for (var i = 0; i < iters; i++) fn();
      return { label: label, ms: +((performance.now() - t0) / iters).toFixed(3) };
    }
    var here = latLngToCell(state.userPos.lat, state.userPos.lng);
    var out = [];
    // writeSaveNow is the real disk write; saveState is what the 50-odd call
    // sites actually pay. On a build without coalescing they are the same.
    if (typeof writeSaveNow === 'function') out.push(bench('writeSaveNow()  [real disk write]', writeSaveNow, 20));
    out.push(bench('saveState()     [what callers pay]', saveState, 20));
    out.push(bench('updateHUD()', updateHUD, 20));
    out.push(bench('tickPlants()', tickPlants, 5));
    out.push(bench('renderPlants()', renderPlants, 20));
    out.push(bench('renderGridMesh()', renderGridMesh, 20));
    out.push(bench('markTileControl()', function () { markTileControl(here.q, here.r); }, 20));
    out.push(bench('sortedPlantKeys()', sortedPlantKeys, 20));
    out.push(bench('onLocationUpdate() [same tile]', function () {
      onLocationUpdate({ coords: { latitude: state.userPos.lat, longitude: state.userPos.lng, accuracy: 5 } });
    }, 20));
    return out;
  });
  console.log('');
  calls.forEach((c) => row(c.label, c.ms));

  const idle = await h.sampleFrames(page);
  console.log('\nidle frames on that save: p50 ' + idle.p50.toFixed(1) + 'ms, p95 ' + idle.p95.toFixed(1) +
    'ms, ' + idle.longFrames + '/' + idle.sampled + ' over 20ms');

  // ---- frame cost against marker density -------------------------------
  // The dense viewport is the shape that actually breaks: a player filling in
  // their own neighbourhood over months arrives here.
  const dense = await h.fixtures.denseViewport(page, { halfQ: 6, halfR: 13 });
  await page.waitForTimeout(500);
  const denseScene = await page.evaluate(() => ({
    markers: Object.keys(plantMarkers).length,
    animated: document.querySelectorAll('.wind-grass-back,.wind-grass-front,.wind-stem').length
  }));
  console.log('\ndense viewport: ' + dense.plants + ' plants, ' + denseScene.markers +
    ' markers on screen, ' + denseScene.animated + ' animated SVG groups');

  const hasBudget = await page.evaluate(() => typeof applyWindBudget === 'function');
  if (hasBudget) {
    console.log('\nambient motion budget sweep (60fps is a 16.7ms p50):');
    const original = await page.evaluate(() => WIND_ANIM_BUDGET);
    for (const b of [0, 8, 16, 24, 40, 80, 1e6]) {
      await page.evaluate((v) => { WIND_ANIM_BUDGET = v; applyWindBudget(); }, b);
      await page.waitForTimeout(450);
      const f = await h.sampleFrames(page, 120);
      console.log('  budget ' + String(b === 1e6 ? 'ALL' : b).padStart(6) +
        '   p50 ' + f.p50.toFixed(1).padStart(6) + 'ms   p95 ' + f.p95.toFixed(1).padStart(6) +
        'ms   ~' + String(Math.round(1000 / f.p50)).padStart(3) + ' fps' +
        (b === original ? '   <- shipped' : ''));
    }
    await page.evaluate((v) => { WIND_ANIM_BUDGET = v; applyWindBudget(); }, original);
  } else {
    // No budget in this build - show what the density costs unmitigated, and
    // what the same scene costs with ambient motion switched off, which is
    // the whole of the difference.
    const on = await h.sampleFrames(page, 120);
    await page.evaluate(() => document.body.classList.add('bg-paused'));
    await page.waitForTimeout(400);
    const off = await h.sampleFrames(page, 120);
    await page.evaluate(() => document.body.classList.remove('bg-paused'));
    console.log('\n  animations on   p50 ' + on.p50.toFixed(1) + 'ms  (~' + Math.round(1000 / on.p50) + ' fps)');
    console.log('  animations off  p50 ' + off.p50.toFixed(1) + 'ms  (~' + Math.round(1000 / off.p50) + ' fps)');
  }

  if (errors.length) { console.log('\nERRORS:'); errors.slice(0, 5).forEach((e) => console.log('  ' + e)); }
  await browser.close();
})();
