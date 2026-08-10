# BLOOM

A chill, location-based gardening game played in your real neighborhood. Plant seeds on your walk, come back every so often to water them, harvest what grows, and build a collection of every flower there is.

**Play it:** open `index.html` in a mobile browser, or visit [metroidrhyme.github.io/Bloom](https://metroidrhyme.github.io/Bloom/). No install required.

There's no score, no timer, and no way to "lose" quickly - it's just a colorful, low-stress reason to get outside.

---

## How to play

1. **Grant GPS access** when prompted. The map centers on your location once locked.
   - First time playing? A short guided tutorial walks you through planting, watering, harvesting, and buying your next seed - it speeds up growth just for that one demo flower so you see the whole loop in under a minute. Skippable anytime via the banner's link.
2. **Tap the ground** near you to plant a seed from your inventory (you start with one Sunflower, one Tulip, and one Daisy) - a picker always confirms which seed before it's spent, so a stray tap never plants one by accident.
3. **Walk back** every so often and tap a growing flower, then tap **Water** once you're close enough.
4. Watering is what advances a stage - not elapsed time. A flower becomes *ready* 12 hours after it was planted or last grew, and your next visit is what moves it up. Seed to sprout to bloom to flourishing cluster is three separate walks back.
5. Once a flower is in bloom or flourishing, **Keep** it for your collection or **Sell** it to the shop for Petals - clusters sell for far more than a single bloom.
6. Spend Petals in the **Seed Shop** (tap your Petals total, top right) on more seeds.

You can tap any flower on the map to check on it from a distance - only *watering*, *harvesting*, and *planting* require being physically close (within 2 hex cells, about a short walk).

### Seeds and Petals

There are no seed tiers. Every seed costs **20 Petals**, and every flower sells for the same: **16 Petals** as a single bloom, **40** as a flourishing cluster. Which flower you plant is a matter of taste, not power.

Selling a single bloom comes in just under what its seed cost, so cashing out early is never clearly correct - the cluster is the payoff, and it's what makes the extra watering visit worth walking.

You can also **extract** a flower you're holding back into seeds (1-2 from a bloom, 2-4 from a cluster) instead of selling it. Extraction is worth a bit more than selling, but only ever returns the species and color you pulled apart - Petals remain the only way to get something you don't already have.

### Flowers, species and color

Every flower has a **species** (its shape - Sunflower, Tulip, Daisy, Hibiscus, Blossom, Rose, Lotus) and a **color**, and the two are completely independent: any color can be worn by any species.

Four colors are **standard** - White, Red, Yellow and Blue. Those are the only ones the shop stocks and the only ones wild flowers grow in. Everything else has to be bred.

### Wilting

Flowers left dry for 48 hours look wilted, and that is the entire consequence - it's cosmetic. Watering clears it. **Flowers never die and are never removed except by harvesting them.** A browser page can't send you a reminder, so a real neglect penalty would land as an unannounced loss on someone who had no way to see it coming. Wilting is a nudge, not a punishment.

### Wild flowers

Once per day, the first time you open the game, up to 10 wild flowers scatter at random within 800 m of you. They're free to pick, always come in a standard color, and can't be watered or grown. They're also the one thing in the game you can lose by leaving it: a wild flower wilts after 12 hours and is gone by 18. Most of a day's crop starts off-screen on purpose - the **Wild Flowers** screen in the menu tells you how far the nearest one is and in which direction.

---

## Technical notes

- **Single file** - the entire game is `index.html` with no build step, same backbone approach as [PorterGame](https://github.com/MetroidRhyme/PorterGame).
- **Dependencies** - [Leaflet 1.9.4](https://leafletjs.com/) loaded from CDN; CartoDB Voyager tiles for a colorful basemap.
- **Storage** - all state lives in a single `localStorage` key (`bloom_state_v1`). Corrupted saves fall back to defaults rather than breaking load. Saves from before the seed economy existed are migrated with starter seeds bootstrapped in automatically.
- **Hex grid** - flat-top axial coordinates (q, r), same ~20 m cell size as Porter; longitude is corrected for the player's latitude on first GPS lock. A soft translucent mesh is drawn once zoomed in close (17+).
- **Player position** - the player isn't shown as a marker, only as a translucent green range circle, so it never sits on top of (and hides) a nearby flower. The circle snaps to the current hex's center rather than following raw GPS, and eases smoothly between hexes.
- **Flower artwork is generated SVG** - every flower is drawn at runtime from a species *shape* (rows of petals, described as data) painted with a *color* palette, so any color can be worn by any species without a single new asset. Flowers used to be system emoji glyphs, which meant their colors came from a font the game doesn't control - unrecolorable, and different on every device.
- **Flower icons scale with zoom** - sized relative to a fixed real-world size rather than a fixed screen-pixel size, so zooming in genuinely makes them bigger.
- **Growth engine** - fully timestamp-derived (not tick-accumulated), so time spent away from the app while the game is closed still counts correctly toward growth, drying out, and wilting.
- **Reduced motion** - the flourishing-cluster sway animation, status pulses, and the player-position easing all honor the OS `prefers-reduced-motion` setting.
