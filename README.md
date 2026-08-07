# BLOOM

A chill, location-based gardening game played in your real neighborhood. Plant seeds on your walk, come back every so often to water them, harvest what grows, and use the shop to grow your collection with rarer flowers.

**Play it:** open `index.html` in a mobile browser, or visit [metroidrhyme.github.io/Bloom](https://metroidrhyme.github.io/Bloom/). No install required.

There's no score, no timer, and no way to "lose" quickly - it's just a colorful, low-stress reason to get outside.

---

## How to play

1. **Grant GPS access** when prompted. The map centers on your location once locked.
   - First time playing? A short guided tutorial walks you through planting, watering, harvesting, and buying your next seed - it speeds up growth just for that one demo flower so you see the whole loop in under a minute. Skippable anytime via the banner's link.
2. **Tap the ground** near you to plant a seed from your inventory (you start with 3 Common seeds) - a picker always confirms which seed before it's spent, so a stray tap never plants one by accident.
3. **Walk back** every so often and tap a growing flower, then tap **Water** once you're close enough.
4. Watered flowers grow from seed, to sprout, to a single bloom, to a full flourishing cluster over a few real days.
5. Once a flower is in bloom or flourishing, **Keep** it for yourself or **Sell** it to the shop for Petals - clusters sell for far more than a single bloom.
6. Spend Petals in the **Seed Shop** (tap your Petals total, top right) on Common, Rare, or Prized seeds - rarer tiers cost more but sell for a lot more too.

You can tap any flower on the map to check on it from a distance - only *watering*, *harvesting*, and *planting* require being physically close (within 2 hex cells, about a short walk).

### Seed tiers

| Tier | Species | Seed cost | Sells for (single / cluster) |
|------|---------|-----------|-------------------------------|
| Common | Sunflower, Tulip, Daisy | 10 Petals | 8 / 18 |
| Rare | Hibiscus, Blossom | 30 Petals | 25 / 55 |
| Prized | Rose, Lotus | 70 Petals | 60 / 130 |

Selling a single bloom roughly breaks even against its own seed cost - the real profit (and the reason to walk back for a second or third watering visit) is in letting it reach the flourishing cluster stage.

### Wilting

Flowers left dry too long wilt (a small water-drop badge appears). Watering always revives a wilted flower. Only a very long stretch of neglect (about a week of no water, in total) causes a flower to return to the earth, freeing that spot to plant something new. It's meant to be forgiving, not punishing.

---

## Technical notes

- **Single file** - the entire game is `index.html` with no build step, same backbone approach as [PorterGame](https://github.com/MetroidRhyme/PorterGame).
- **Dependencies** - [Leaflet 1.9.4](https://leafletjs.com/) loaded from CDN; CartoDB Voyager tiles for a colorful basemap.
- **Storage** - all state lives in a single `localStorage` key (`bloom_state_v1`). Corrupted saves fall back to defaults rather than breaking load. Saves from before the seed economy existed are migrated with starter seeds bootstrapped in automatically.
- **Hex grid** - flat-top axial coordinates (q, r), same ~20 m cell size as Porter; longitude is corrected for the player's latitude on first GPS lock. A soft translucent mesh is drawn once zoomed in close (17+).
- **Player position** - the player isn't shown as a marker, only as a translucent green range circle, so it never sits on top of (and hides) a nearby flower. The circle snaps to the current hex's center rather than following raw GPS, and eases smoothly between hexes.
- **Flower icons scale with zoom** - sized relative to a fixed real-world size rather than a fixed screen-pixel size, so zooming in genuinely makes them bigger.
- **Growth engine** - fully timestamp-derived (not tick-accumulated), so time spent away from the app while the game is closed still counts correctly toward growth, drying out, and wilting.
- **Reduced motion** - the flourishing-cluster sway animation, status pulses, and the player-position easing all honor the OS `prefers-reduced-motion` setting.
