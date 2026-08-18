# Bloom - Claude Instructions

## Encoding & Output Rules

Never emit non-ASCII characters in HTML, JS, or PowerShell files. This includes U+00A0 (non-breaking space), U+00B7 (middle dot), smart quotes, em-dashes, and similar glyphs. Use HTML entities (e.g., `&nbsp;`, `&middot;`) or plain ASCII equivalents instead. Non-ASCII glyphs in served strings or scripts cause mojibake and PowerShell parse failures.

Emoji used for game visuals are written as JS `\u{...}` escapes (inside `<script>`) or HTML numeric entities `&#x...;` (inside markup) rather than raw glyphs, so the file itself stays pure ASCII while still rendering emoji at runtime.

## Versioning

Bump the version number on every change. It lives in `index.html` at the `#game-version` span (currently `v1.0.0`). Bump the patch number (third segment) for tweaks/fixes, minor for new features, major for large overhauls. Include the new version in the commit message.

## App structure

Everything - HTML, CSS, and JS - lives in the single `index.html` file, following the same backbone as [PorterGame](https://github.com/MetroidRhyme/PorterGame): Leaflet.js map, flat-top axial hex grid, `navigator.geolocation.watchPosition` for player tracking, and `localStorage` for persistence. Unlike Porter, Bloom's whole save is one JSON blob under `bloom_state_v1` rather than many individual keys - state is small (a dictionary of planted flowers plus a few stats), so a single-blob save is simpler and sufficient.

Key pieces:
- `state.plants` - dictionary keyed by `"q,r"` hex key, one entry per planted flower.
- `recomputePlant(p, now)` - the growth engine. Fully timestamp-derived (not tick-accumulated) so offline time (the whole point of a walking game) is handled correctly. Read the comment above it before changing timing constants.
- `PLANT_RANGE_HEX`, `WATER_DURATION_MS`, `GRACE_MS`, `DEATH_MS`, `GROWTH_THRESHOLDS` - all the pacing knobs live at the top of the script.
- `buildPlantVisual()` - shared by both the map marker icon and the big panel preview; returns rendered box dimensions alongside the HTML so callers can size their container to match.

## Workflow

After completing any change, commit and push to `main` directly by default (no PRs, no branches):
```
git add -A
git commit -m "..."
git push
```

Push to `main` immediately once a change is verified (see the `bloom-ship` skill), without waiting for a separate "go ahead" - that confirmation isn't needed unless asked for below. The one exception: if the user asks to test, try out, or otherwise check something first before it ships, hold off on committing/pushing until they actually say to ship it - don't push work they explicitly asked to test first.
