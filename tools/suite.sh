#!/usr/bin/env bash
# Run every check and report the REAL exit code of each.
#
# Why this file exists: on 2026-10-20 the steward ran the suite in a loop that printed
# `$(printf '%-28s' $(basename $f)) exit=$?` — and `$?` there is the status of the command substitution, always 0.
# The suite was reported green while `checks/leg8-registry.cjs` had been failing since 2026-10-19.
set -uo pipefail
cd "$(dirname "$0")/.."
# SUITE_CHECKS_DIR exists so checks/leg43-suite-negative.cjs can drive this runner over a
# throwaway directory. It defaults to checks/, which is exactly the old behaviour.
checks_dir="${SUITE_CHECKS_DIR:-checks}"
fail=0
for f in "$checks_dir"/leg*.cjs "$checks_dir"/guard-demo.cjs; do
  [ -f "$f" ] || continue
  out="$(node "$f" 2>&1)"; code=$?
  if [ $code -eq 0 ]; then
    printf 'PASS  %s\n' "$(basename "$f")"
  else
    fail=$((fail+1))
    printf 'FAIL  %s (exit %s)\n' "$(basename "$f")" "$code"
    printf '%s\n' "$out" | grep -E '^(FAIL|AssertionError|Error)' | head -3 | sed 's/^/        /'
  fi
done
tsc_out="$(npx tsc --noEmit 2>&1)"; tsc=$?
[ $tsc -eq 0 ] && echo "PASS  tsc --noEmit" || { echo "FAIL  tsc --noEmit"; echo "$tsc_out" | head -3; fail=$((fail+1)); }
echo
[ $fail -eq 0 ] && echo "SUITE GREEN" || echo "SUITE RED: $fail failing"
exit $fail
