---
name: bloom-add-species
description: Use when adding a new flower species (and its signature colors) to Bloom's SPECIES/COLORS arrays - what the engine already handles for free (dailyStock, TOTAL_VARIANTS, journal tabs, the breeding table) versus what's hardcoded to the current species count and must be audited by hand (the Shop's fixed-3-row crate layout, milestone tier ceilings, stale prose comments). Also covers the petal-row shape schema and the end-to-end verification checklist for a new species.
---

# Adding a flower species to Bloom

Species and color counts are described in the code as "open-ended" (see the
comment above `#seed-rail` in `index.html`), and most of the engine really
is - but one real subsystem is not, and it silently drops content instead
of erroring when you outgrow it. This skill is the checklist from actually
doing this once (Iris, the 8th species, `v2.26.0`).

## 1. The two array entries

**`SPECIES`** - shape is rows of petals, outermost first, drawn by
`petalShape`/`flowerHeadInner` (search `var SPECIES = [`):

```js
{ key: 'iris', name: 'Iris', base: 'blue',
  shape: { rows: [{ n: 3, rx: 15, ry: 27, r: 9, tip: 'point' },
                  { n: 3, rx: 11, ry: 21, r: 23, rot: 60, tip: 'round', deep: true }],
           center: { r: 5, stamen: true } } }
```

- `n` petals per row, `rx`/`ry` half-width/height, `r` = distance from
  center, `rot` = degree offset (lets a row interleave with the one
  outside it), `tip` is `'round'` | `'point'` | `'notch'`, `deep: true`
  paints that row a shade darker (inner rows).
- `center.dots`/`center.stamen` are optional disc decorations.
- `base` **must** be one of the four `STANDARD_COLORS` (white/red/yellow/
  blue) - it's what wild flowers and the shop ever roll before any
  breeding happens, so an unbred color would be self-contradictory.
- Pick a silhouette that's structurally different from the existing seven
  (petal count, row count, or fold symmetry), not just a recolor of one of
  them - see the design doc process below.

**`COLORS`** - exactly two signature entries per species, appended near the
other signatures (search `species: '<other-key>'` to find that block):

```js
{ id: 'indigo', name: 'Indigo', tier: 3, species: 'iris',
  petal: '#4b3a8f', center: '#c9a8ff', grad: ['#8f7ad6', '#4b3a8f', '#1a1338'],
  glow: '#6f5bc9', spark: '#d9c8ff' }
```

`species: '<key>'` is what locks a color to one shape - `grad`/`glow`/
`spark` are what make it render with the gradient+halo+sparkle treatment
instead of a flat fill. No changes needed to the breeding table itself:
`SIGNATURE_TABLE`'s `gold+gold`/`black+gold` recipes are species-generic
(`sig0`/`sig1` placeholders resolved through `signatureColorsOf(speciesKey)`
at cross time) - adding the two `COLORS` entries is the whole breeding
integration.

## 2. Already dynamic - no changes needed

Confirmed by grepping the file for `SPECIES.length`/`COLORS.length`/
`.reduce`/`.map` call sites before touching anything:

- `dailyStock()` - one crate per `SPECIES` entry, whatever the count.
- `TOTAL_VARIANTS`, `colorsForSpecies`/`signatureColorsOf` - derived from
  the arrays, not a stored number.
- `.journal-tabs`/`.notes-tab` layout - `flex: 1 1 0` per tab, and both
  `journalTabsHtml`/`notesTabsHtml` are `SPECIES.map(...)`.
- The seed rail (`renderSeedPetals`, `SEED_ROW`) - index-based, positions
  computed in JS, no fixed slot count.
- `MILESTONE_TRACKS`' `species`/`variants` tiers already used
  `SPECIES.length`/`TOTAL_VARIANTS` as their top tier before this round.

## 3. Hardcoded to the old count - audit these by hand

**The Shop's crate rows are the real landmine.** `renderShopRows()` (search
`function renderShopRows`) fills exactly three fixed HTML containers
(`stand-row-1/2/3`, hardcoded in the markup, not generated):

```js
document.getElementById('stand-row-1').innerHTML = crates.slice(0, 3).join('');
document.getElementById('stand-row-2').innerHTML = crates.slice(3, 6).join('');
document.getElementById('stand-row-3').innerHTML = crates.slice(6, 8).join('') + fert;
```

Rows 1-2 always take exactly 3 (by design - `.stand-row-crates` stretches
them edge to edge). Row 3 takes everything past index 6 plus the
fertilizer sack, natural-width and centered (`.stand-row-last`). Going
from 7 to 8 species was a one-line boundary tweak (`slice(6, 7)` ->
`slice(6, 8)`) - **before this fix it silently dropped the 8th species'
crate from sale with no error**, because the slice's upper bound was a
literal number matching the old `SPECIES.length`, not derived from it.
Prefer `crates.slice(6)` (no upper bound) over another hardcoded number if
you're already in this code - it's equivalent today and stops the next
species from needing this same manual bump. Either way, **always verify
row 3 actually renders one button per remaining species** (see the
Playwright checklist below) rather than trusting the slice looks right.

This only postpones the real ceiling, though: row 3 has no per-row item
cap, so it keeps growing by one natural-width (86px) item per species past
the 7th. Comfortable up to maybe 4-5 items sharing it with the sack
(species count roughly in the 9-11 range); past that it will overflow
narrow phone widths and needs an actual restructure - a fourth HTML row,
or switching row 3 to a responsive `auto-fill` grid - not another
slice-boundary edit.

**Other spots to grep for the literal old number**, not just the word
"species" (some of these are prose-only, low risk; some are load-bearing):

- A milestone tier hardcoding a total instead of deriving it, the way
  `MILESTONE_TRACKS`' `signatures` tier used to hardcode `14` (2 x 7)
  before this round added a `TOTAL_SIGNATURES` constant
  (`COLORS.filter(c => c.species).length`) alongside `TOTAL_VARIANTS`,
  mirroring how the `species`/`variants` tiers already referenced
  `SPECIES.length`/`TOTAL_VARIANTS` instead of a number.
- Any `exclusiveSpeciesOf`/signature-count doc comment quoting a fixed
  count of signature colors.
- Prose comments in `#seed-rail`'s CSS, `dailyStock()`, `renderShopRows()`,
  and the journal's `TOTAL_VARIANTS` block that spell out "seven"/"7" or
  "fourteen"/"14" as if they were fixed - cheap to fix, misleading to
  leave, but not behavior-affecting on their own (unlike the shop slice).

Search pattern that catches both: `grep -n '\b7\b\|\bseven\b\|\bSeven\b'`
(swap in whatever the *previous* count was) across the whole file, not
just within `SPECIES`/`COLORS` - the two-line diff already checked by
`node --check` doesn't catch a stale array bound three thousand lines away.

## 4. Verification checklist (Playwright, see `bloom-playtest`)

Beyond the standard `bloom-ship` regression pass, a new species needs its
own scenario. Stub Leaflet/tiles per `bloom-playtest` section 1, then in
`page.evaluate`:

- Roster: `SPECIES.length`, `COLORS.length`, `TOTAL_VARIANTS`,
  `TOTAL_SIGNATURES` (or whatever the ceiling constants are) all reflect
  the new count; `signatureColorsOf('<newkey>')` returns exactly the two
  new ids.
- `flowerSVG(speciesFor('<newkey>'), colorFor(id), px)` for a handful of
  colors including both new signatures - assert the returned markup has no
  `NaN`/`undefined` (a wrong `rx`/`ry`/`r` shows up exactly this way, not
  as a thrown error).
- `dailyStock().length` equals the new species count, and after calling
  `renderShopRows()`, every stand row's `.stand-item` count sums back to
  that same number - this is the check that would have caught the
  slice-boundary bug.
- Buy and plant it for real: `buySeed(vk)` (not `confirmBuySeed` - see the
  `bloom-playtest` gotcha), then `plantSeedAt(q, r, vk)`, then
  `buildPlantVisual(...)` on the result - no `NaN`/`undefined` in the
  visual markup.
- Breeding: run `crossColor('gold', 'gold', '<newkey>')` and
  `crossColor('black', 'gold', '<newkey>')` a few hundred times each and
  assert the outcome sets match `SIGNATURE_TABLE`'s weights, and that an
  *existing* species' own signature cross is unaffected.
- `renderJournalPage('<newkey>')`/`renderCrossTree('<newkey>')` - tab count
  matches the new species count, the journal page has one spot per color
  in `colorsForSpecies('<newkey>')`, and the tree's signature row holds
  exactly that species' two signatures.
- A `saveState()`/`localStorage` round-trip with a planted flower of the
  new species present, and a second parse for idempotency.

## 5. If you're choosing among candidate species first

If the species itself isn't decided yet, mock up options as live-rendered
SVG (the real `petalShape`/`flowerHeadInner` math, not illustration) in an
Artifact before touching `index.html` - side-by-side comparison is much
easier to react to than a written description of row/petal counts. See
this repo's `Eighth Species` artifact for the pattern (candidate cards,
comparison table, then a full-palette section for the one actually
chosen).
