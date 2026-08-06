# BLOOM

A chill, location-based gardening game played in your real neighborhood. Plant seeds on your walk, come back every so often to water them, and watch your neighborhood slowly fill with flowers.

**Play it:** open `index.html` in a mobile browser. No server or install required.

There's no score, no timer, and no way to "lose" quickly - it's just a colorful, low-stress reason to get outside.

---

## How to play

1. **Grant GPS access** when prompted. The map centers on your location once locked.
2. **Tap the ground** near you to plant a seed. It sprouts a random flower species.
3. **Walk back** every so often and tap a growing flower, then tap **Water** once you're close enough.
4. Watered flowers grow from seed, to sprout, to a single bloom, to a full flourishing cluster over a few real days.

You can tap any flower on the map to check on it from a distance - only *watering* requires being physically close (within 2 hex cells, about a short walk).

### Wilting

Flowers left dry too long wilt (a small water-drop badge appears). Watering always revives a wilted flower. Only a very long stretch of neglect (about a week of no water, in total) causes a flower to return to the earth, freeing that spot to plant something new. It's meant to be forgiving, not punishing.

---

## Technical notes

- **Single file** - the entire game is `index.html` with no build step, same backbone approach as [PorterGame](https://github.com/MetroidRhyme/PorterGame).
- **Dependencies** - [Leaflet 1.9.4](https://leafletjs.com/) loaded from CDN; CartoDB Voyager tiles for a colorful basemap.
- **Storage** - all state lives in a single `localStorage` key (`bloom_state_v1`). Corrupted saves fall back to defaults rather than breaking load.
- **Hex grid** - flat-top axial coordinates (q, r), same ~20 m cell size as Porter; longitude is corrected for the player's latitude on first GPS lock.
- **Growth engine** - fully timestamp-derived (not tick-accumulated), so time spent away from the app while the game is closed still counts correctly toward growth, drying out, and wilting.
- **Reduced motion** - the flourishing-cluster sway animation and status pulses honor the OS `prefers-reduced-motion` setting.
