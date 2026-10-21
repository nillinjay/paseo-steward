#!/usr/bin/env bash
# Build a review packet: the EXACT code a reviewer needs, extracted, with file:line markers.
#
# Why: on 2026-10-20 an opus leg read eight whole files. Reading is the dominant cost and it is NOT free over
# repeated turns (T-115: 1,363,249 cached tokens for one component). A reviewer does not need whole files; it
# needs the functions the finding lives in, the type it depends on, and the test that pins the behaviour.
#
# Usage: tools/digest.sh <out.md> "<what to judge>" <file:start-end> [<file:start-end> ...]
#        tools/digest.sh --selftest
#
# Beside the packet it writes <out.md>.meta.json: each engine's spec, line count and the sha256 of the exact text
# between its fences. tools/review-pack-validate.mjs checks the packet against it before a reviewer is paid for.
set -euo pipefail

if [ "${1:-}" = "--selftest" ]; then
  tmp="$(mktemp -d)"
  printf 'line1\nline2\nline3\n' > "$tmp/a.ts"
  "$0" "$tmp/out.md" "selftest" "$tmp/a.ts:2-3" >/dev/null
  grep -q 'a.ts:2-3' "$tmp/out.md" && grep -q 'line2' "$tmp/out.md" && echo "digest selftest OK"
  rm -rf "$tmp"; exit $?
fi

OUT="${1:?out path}"; JUDGE="${2:?what to judge}"; shift 2
# `--fn` mode: specs are `file:symbol` and each symbol is printed whole, so a packet cannot split a function.
FN_MODE=0; [ "${1:-}" = "--fn" ] && { FN_MODE=1; shift; }
max_lines="${DIGEST_MAX_LINES:-400}"
META="$OUT.meta.json"
rm -f "$META"
ENGINES="$(mktemp)"
trap 'rm -f "$ENGINES"' EXIT
record() { printf '%s\t%s\t%s\n' "$1" "$(printf '%s\n' "$2" | sha256sum | cut -d' ' -f1)" "$3" >> "$ENGINES"; }

{
  echo "# Review packet"
  echo
  echo "**What to judge.** $JUDGE"
  echo
  echo "Read **only this file**. Every extract is verbatim with a \`file:start-end\` marker; nothing has been"
  echo "paraphrased. If something you need is missing, say exactly which and stop - do not open the repository"
  echo "looking for it."
  echo
} > "$OUT"

total=0
for spec in "$@"; do
  if [ "$FN_MODE" = "1" ]; then
    file="${spec%%:*}"; symbol="${spec##*:}"
    [ -f "$file" ] || { echo "missing: $file" >&2; exit 2; }
    body="$(node "$(dirname "$0")/extract-fn.mjs" "$file" "$symbol")" || exit 2
    n=$(printf '%s\n' "$body" | wc -l)
    echo "## $file :: $symbol ($n lines)" >> "$OUT"
    echo '```'"${file##*.}" >> "$OUT"
    printf '%s\n' "$body" >> "$OUT"
    echo '```' >> "$OUT"; echo >> "$OUT"
    record "$spec" "$body" "$n"
    total=$((total + n))
    continue
  fi
  # Accept both `file:10-40` and `file:10,40`: a comma is what a person types after reading a line number.
  file="${spec%%:*}"; range="${spec##*:}"; range="${range/,/-}"
  start="${range%%-*}"; end="${range##*-}"
  [ -f "$file" ] || { echo "missing: $file" >&2; exit 2; }
  n=$((end - start + 1))
  echo "## $file:$start-$end" >> "$OUT"
  echo '```'"${file##*.}" >> "$OUT"
  body="$(awk -v s="$start" '{ printf "%5d  %s\n", s + NR - 1, $0 }' <(sed -n "${start},${end}p" "$file"))"
  printf '%s\n' "$body" >> "$OUT"
  echo '```' >> "$OUT"; echo >> "$OUT"
  record "$spec" "$body" "$(printf '%s\n' "$body" | wc -l)"
  total=$((total + n))
done

{
  echo "---"
  echo "extract lines: $total (budget $max_lines)"
} >> "$OUT"

if [ "$total" -gt "$max_lines" ]; then
  echo "digest: $total lines exceeds the $max_lines budget — narrow the ranges" >&2
  exit 3
fi
node -e '
const fs = require("node:fs");
const [meta, engines] = process.argv.slice(1);
const rows = fs.readFileSync(engines, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t"));
const data = { created_at: new Date().toISOString(), engines: rows.map(([spec, sha256, lines]) => ({ spec, sha256, lines: Number(lines) })), judge_present: true };
fs.writeFileSync(meta + ".tmp", JSON.stringify(data, null, 2) + "\n");
fs.renameSync(meta + ".tmp", meta);
' "$META" "$ENGINES"
echo "$OUT ($total lines)"
