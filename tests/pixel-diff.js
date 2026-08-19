// Proves a rendering change didn't change what the game looks like.
//
//   node tests/pixel-diff.js                       # working copy vs HEAD
//   node tests/pixel-diff.js old.html new.html     # any two builds
//
// This is the check that makes a rendering optimization safe to ship. A perf
// change that alters what the game looks like is a redesign, not an
// optimization, and needs to be discussed as one.
//
// Both sides render under prefers-reduced-motion, which freezes every ambient
// animation on BOTH builds - otherwise the wind sway alone guarantees a
// difference and the comparison tells you nothing. Byte-identical is a
// realistic bar, not an aspiration: every optimization in v2.38.0 met it.
//
// The fixture puts everything visually load-bearing in one frame - grid mesh,
// today-access fill, markers across several species and stages, a rain rune
// and a grow rune with their full boundary geometry - so one comparison
// covers the lot.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const h = require('./harness');

const OUT = path.join(__dirname, 'out');

// Screenshots the map only once the page has stopped changing.
//
// A fixed sleep is not enough here and quietly produces false differences:
// comparing a build against ITSELF came back different on roughly one run in
// three, at ~36 bytes out of 1.1MB - a handful of anti-aliased pixels from
// something still settling. A tool that reports a difference when there is
// none is worse than no tool, because the natural response is to start
// hunting a rendering bug that does not exist.
//
// Two fixes, both needed. First, pin the nondeterminism at the source:
// wild flowers and weeds spawn off unseeded Math.random, so a spawn landing
// on one run and not the other is a real content difference between two
// identical builds. Second, settle on evidence rather than on a timer -
// shoot repeatedly until two consecutive frames are byte-identical, which is
// the page telling us it has stopped moving.
async function shoot(browser, file, out) {
  const { page, errors } = await h.openBloom(browser, { file: file, reducedMotion: 'reduce' });

  await page.evaluate(() => {
    var seed = 20240819;
    Math.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  });

  // Pin every ambient element to ONE definite appearance, on both builds.
  //
  // Two separate things make an unpinned shot unreliable. Which markers are
  // inside the ambient motion budget depends on a distance ranking that can
  // tie (markers mirrored about screen centre are exactly equidistant), so
  // marker N and marker N+1 can swap membership between loads. And a
  // budgeted-out marker is not in the same visual state as an animating one
  // even under reduced motion: 'animation: none' holds an element at its
  // declared opacity, while reduced motion runs the animation once and lands
  // it on its final keyframe - 0.6 versus 0.45 for a bloom halo. Together
  // those produced a stable ~36-byte difference between a build and itself
  // on about one run in three, and a systematic one against a build that
  // predates the budget entirely.
  //
  // Forcing the end state here removes both. Nothing is hidden - every halo,
  // spark and grass clump still renders, just at a fixed phase - so a real
  // regression in any of them still shows up.
  await page.addStyleTag({ content: [
    '.wind-grass-back, .wind-grass-front, .wind-stem { animation: none !important; }',
    '.bloom-halo { animation: none !important; opacity: 0.6 !important; }',
    '.bloom-spark { animation: none !important; opacity: 0.8 !important; }',
    '.wild-glow { animation: none !important; }',
    // rescalePlantIcons() CSS-scales each marker's inner content div during a
    // zoom gesture and relies on the next full rebuild to hand back
    // untransformed DOM. Whether a residual sub-pixel scale is still sitting
    // there when the screenshot lands depends on whether setView happened to
    // fire a zoom event, which varies by run - and a sub-pixel scale shifts
    // anti-aliasing by exactly one channel step on a handful of grass
    // pixels. That produced a deterministic-but-run-dependent 9-pixel
    // difference between a build and itself. The inner div's transform is
    // ONLY ever that rescale (Leaflet's own positioning lives on the marker
    // element itself, one level up), so clearing it here is precise.
    '.leaflet-marker-icon > * { transform: none !important; }',
    // The HUD sits on top of the map, and an element screenshot captures
    // whatever overlaps it - including #game-version, which by house rule
    // changes on EVERY ship. Left visible, this tool would report a
    // difference for literally every change ever made, starting with a
    // 45-pixel delta-80 blob that is just a '7' becoming an '8'. The HUD's
    // own text is covered by the regression suite instead; this comparison
    // is about map rendering.
    '#hud-top, #hud-bottom, #tutorial-banner { visibility: hidden !important; }'
  ].join('\n') });

  await h.lockGps(page);
  await h.fixtures.showcase(page);
  await page.waitForTimeout(600);

  // Ambient scenery is not what this comparison is about, and it is the part
  // that spawns on its own schedule - clear it and keep it clear.
  await page.evaluate(() => {
    state.wild = {}; state.weeds = {};
    renderWild(); renderWeeds();
    renderGridMesh(); renderPlants(); renderRainRings(); renderGrowRunes();
  });

  const tmp = out + '.settle.png';
  let previous = null, settled = false;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(250);
    await page.locator('#map').screenshot({ path: tmp });
    const current = h.pngPixels(tmp).pixels;
    if (previous && current.equals(previous)) { settled = true; break; }
    previous = current;
  }
  fs.renameSync(tmp, out);
  await page.close();
  if (!settled) errors.push('WARNING: ' + path.basename(file) + ' never settled to two identical frames');
  return errors;
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  let before = process.argv[2], after = process.argv[3];
  if (!before) {
    before = path.join(OUT, 'head-index.html');
    // Default comparison: the working copy against what is committed, which
    // is the question being asked most of the time.
    fs.writeFileSync(before, execFileSync('git', ['show', 'HEAD:index.html'], { cwd: h.REPO_ROOT, maxBuffer: 1 << 28 }));
    console.log('baseline: HEAD:index.html');
  } else {
    console.log('baseline: ' + before);
  }
  after = after || h.GAME;
  console.log('compared: ' + after + '\n');
  before = path.resolve(before); after = path.resolve(after);

  const browser = await h.launch();
  const aPng = path.join(OUT, 'map-before.png'), bPng = path.join(OUT, 'map-after.png');
  const errA = await shoot(browser, before, aPng);
  const errB = await shoot(browser, after, bPng);
  await browser.close();

  const a = h.pngPixels(aPng), b = h.pngPixels(bPng);
  console.log('dimensions: ' + a.hdr.w + 'x' + a.hdr.h + ' vs ' + b.hdr.w + 'x' + b.hdr.h);

  let failed = 0;
  if (a.hdr.w !== b.hdr.w || a.hdr.h !== b.hdr.h) {
    console.log('\nDIFFERS - the two builds render at different sizes.');
    failed = 1;
  } else if (a.pixels.equals(b.pixels)) {
    console.log('\nPIXEL-IDENTICAL - the change is invisible, as an optimization should be.');
  } else {
    const d = h.diffRegion(a, b);
    const total = a.hdr.w * a.hdr.h;
    const line = d.pixels + ' of ' + total + ' pixels (' + (100 * d.pixels / total).toFixed(3) +
      '%), max channel delta ' + d.maxDelta +
      ', region x ' + d.box.minX + '-' + d.box.maxX + ' y ' + d.box.minY + '-' + d.box.maxY;
    if (h.isRasterNoise(d, total)) {
      console.log('\nIDENTICAL WITHIN RASTER NOISE - ' + line);
      console.log('A single-step difference on a few anti-aliased pixels is the rasterizer,');
      console.log('not the build. Treat this as a pass.');
    } else {
      console.log('\nDIFFERS - ' + line);
      console.log('Compare ' + aPng + ' and ' + bPng + ' by eye before deciding this is fine.');
      failed = 1;
    }
  }

  const errs = errA.concat(errB);
  if (errs.length) { console.log('\nERRORS:'); errs.slice(0, 5).forEach((e) => console.log('  ' + e)); }
  process.exit(failed);
})();
