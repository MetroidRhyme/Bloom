#!/usr/bin/env bash
# The full pre-ship pass. Steps 1-3 of the bloom-ship checklist, in order of
# how cheap they are to run and how early they catch things.
set -uo pipefail
cd "$(dirname "$0")/.."
status=0

echo "== ASCII scan (must print 0) =="
# grep exits 1 on zero matches, which is success here, not failure.
count=$(grep -cP '[^\x00-\x7F]' index.html || true)
echo "$count non-ASCII characters"
[ "$count" = "0" ] || { echo "FAIL: non-ASCII in index.html"; status=1; }

echo
echo "== Syntax check =="
python3 -c "
import re
html = open('index.html').read()
open('/tmp/bloom-script.js','w').write(max(re.findall(r'<script>(.*?)</script>', html, re.S), key=len))
"
node --check /tmp/bloom-script.js && echo SYNTAX_OK || status=1

echo
echo "== Regression suite =="
node tests/regression.js || status=1

echo
echo "== Zoom / icon sizing =="
node tests/zoom.js || status=1

echo
echo "== Pixel diff vs HEAD =="
# Expected to differ if this change is meant to look different - read it,
# don't just take the exit code.
node tests/pixel-diff.js || echo "(pixel diff reported a difference - confirm it is intended)"

echo
[ "$status" = "0" ] && echo "ALL GREEN" || echo "SOMETHING FAILED - see above"
exit $status
