---
name: bloom-ship
description: Use before committing/pushing any change to Bloom's index.html - the verify-then-ship checklist (ASCII scan, syntax check, regression suite, version bump, changelog, commit, push). Invoke whenever a Bloom code change is "done" and about to be shipped.
---

# Shipping a Bloom change

Bloom is a single-file game (`index.html`) with no build step and no CI - the
only thing standing between a change and production is you, right now. Do
not commit or push until every step below has actually been run in this
session. "The diff looks right" is not verification.

## 1. ASCII scan (non-negotiable, per CLAUDE.md)

```
grep -cP '[^\x00-\x7F]' index.html
```

Must print `0` (grep exits 1 on zero matches - that's success, not failure).
Any non-ASCII glyph (smart quotes, em-dash, non-breaking space, a raw emoji)
in HTML/JS/PowerShell breaks mojibake-sensitive contexts. Fix with entities
(`&nbsp;`, `&mdash;`) or JS `\u{...}` escapes, never by disabling the check.

## 2. Syntax check

The game's main logic lives in one big inline `<script>`. Extract and check it:

```bash
python3 -c "
import re
html = open('index.html').read()
scripts = re.findall(r'<script>(.*?)</script>', html, re.S)
main = max(scripts, key=len)   # the game logic is the largest inline script
open('/tmp/index-script.js','w').write(main)
"
node --check /tmp/index-script.js && echo SYNTAX_OK
```

## 3. Regression suite

There is no committed test suite - Playwright test scripts live in the
session scratchpad and do not survive between sessions. If prior scripts
are still present this session (check
`<scratchpad>/pw-test/*.js`), rerun every one relevant to the area touched.
If they are gone (fresh session, different container), rebuild the ones
that matter for the change before shipping - see the `bloom-playtest` skill
for the harness pattern (CDN interception, tile aborts, chromium launch
path). At minimum, before shipping any change, confirm:

- No `pageerror` events and no unexpected `console.error` (tile-load
  `ERR_FAILED` from aborted OSM requests is expected noise and fine to ignore).
- The specific feature touched still behaves correctly end-to-end (plant,
  water, harvest, sell, whatever the change affects).
- `localStorage` migration still works if `state` shape changed at all -
  load an old-shaped saved blob, confirm it upgrades without data loss, and
  confirm a *second* load doesn't re-apply the migration (idempotency).

Do not commit on a "looks fine in the diff" basis - actually load the page
in headless chromium and drive the changed code path.

## 4. Version bump

Bump `<span id="game-version">` near the top of `index.html`
(search for `id="game-version"`). Patch (third segment) for tweaks/fixes,
minor for new features/capabilities, major for large overhauls. This
session's precedent: pure rendering/positioning correctness fixes with no
new capability = patch bump; a whole new subsystem (e.g. the Greenhouse)
= minor bump.

## 5. CHANGELOG entry

Find the `CHANGELOG` array (search `var CHANGELOG = [`). Add a new entry as
the **first** element, matching the version you just set:

```js
{ version: 'vX.Y.Z', changes: [
  '...',
  '...'
] },
```

Write it for a player, not a developer - what changed in how the game
looks or feels, never the code/data mechanism behind it. Only the entry
whose `version` matches the live `#game-version` is ever shown in the
in-game "What's New" popup, so the entry for the version you're shipping
must exist before or exactly when you bump the version span - they land in
the same commit.

## 6. Re-verify after the version/changelog edit itself

The edit in steps 4-5 is still an edit to `index.html` - rerun the ASCII
scan and syntax check (steps 1-2) after making it, not just before. A typo
in a changelog string is exactly the kind of thing that slips through
otherwise.

## 7. Commit and push

Per CLAUDE.md: commit and push directly to `main`, no PRs, no branches.

```bash
git add -A
git commit -m "vX.Y.Z: <short summary>

<body: what changed and why, plus what verification was run>

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
git push
```

Commit body should name the actual regression checks that passed (not just
assert "tested") - this is the only record that verification happened,
since there's no CI log to point to later.
