#!/usr/bin/env bash
# What did that leg actually cost? Run it after every dispatch, before the next one.
#
# On 2026-10-20 a single opus leg (T-115) cost $1.41 and 1.36 M cached tokens. Claude's 5-hour window went from
# 13 % to 49 % used. Nothing in the dispatch measured cost, so nothing stopped it. Cached tokens are not free:
# every turn re-sends the whole conversation, so a brief that lets the worker read broadly charges for that
# context on every single turn after it.
#
# Usage: tools/leg-cost.sh <agent-id-or-prefix>
set -euo pipefail
ID="${1:?usage: leg-cost.sh <agent-id>}"
PASEO="${PASEO_BIN:-paseo}"
line="$("$PASEO" agent inspect "$ID" 2>/dev/null | grep -i '^LastUsage' | head -1)"
[ -n "$line" ] || { echo "no usage for $ID"; exit 1; }
python3 - "$line" <<'PY'
import re, sys
line = sys.argv[1]
def num(key):
    m = re.search(rf"{key}: ([\d.]+)", line)
    return float(m.group(1)) if m else 0.0
inp, out, cached, cost = num("InputTokens"), num("OutputTokens"), num("CachedTokens"), num("CostUsd")
print(f"input={inp:,.0f} output={out:,.0f} cached={cached:,.0f} cost=${cost:.2f}")
verdict = []
if cost > 0.50: verdict.append(f"cost ${cost:.2f} > $0.50")
if cached > 500_000: verdict.append(f"cached {cached:,.0f} > 500k")
if out > 20_000: verdict.append(f"output {out:,.0f} > 20k")
print(("TOO BROAD: " + ", ".join(verdict) + " — the brief let it read or write too much; that context is paid every turn") if verdict else "within budget")
PY
