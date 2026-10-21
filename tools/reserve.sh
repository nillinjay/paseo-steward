#!/usr/bin/env bash
# Atomic per-task reservation. Two dispatches of the SAME task must never both win.
#
# The old duplicate scan in tools/dispatch.sh read the workspace list, then read the agent list, then
# launched: two processes could both pass the scan before either workspace existed. The window is
# closed here by holding an flock over the ENTIRE check-and-write, so exactly one caller wins.
#
# Reservation state lives beside the repo, never inside a supervised project's tree:
#   $REPO/.locks/<task>.lock   flock target (never deleted)
#   $REPO/.locks/<task>.json   {task, token, pid, at}, the actual reservation
#
# A reservation is taken when the json is younger than 6 hours OR a live workspace/agent carries the
# task key (the same rule dispatch.sh used inline). Nothing here decides permission: it only decides
# whether this task id is already out.
#
# Usage:
#   tools/reserve.sh <TASK_ID>                     -> "WON <token>" (exit 0) or "LOST <reason>" (exit 3)
#   tools/reserve.sh --release <TASK_ID> <token>   -> deletes the json only when the token matches
#
# WON is printed only after the json is on disk and reads back with this token; a write that fails is
# "LOST write-failed" (exit 3), never a win nobody recorded (V12-07).
set -u

REPO="${RESERVE_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCKS="$REPO/.locks"
FRESH_MINUTES=360

usage() {
  echo "usage: reserve.sh [--release] <TASK_ID> [token]" >&2
  exit 2
}

MODE="reserve"
if [ "${1:-}" = "--release" ]; then MODE="release"; shift; fi
TASK="${1:-}"
[ -n "$TASK" ] || usage
shift || true
TOKEN_ARG="${1:-}"

KEY="$(printf '%s' "$TASK" | tr '[:upper:]' '[:lower:]')"
JSON="$LOCKS/$TASK.json"
LOCK="$LOCKS/$TASK.lock"

mkdir -p "$LOCKS"

PASEO="${PASEO_BIN:-paseo}"
command -v "$PASEO" >/dev/null 2>&1 || PASEO="paseo"

json_token() {
  sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" 2>/dev/null | head -n 1
}

is_fresh() {
  [ -f "$JSON" ] || return 1
  [ -n "$(find "$JSON" -maxdepth 0 -mmin -"$FRESH_MINUTES" 2>/dev/null)" ]
}

# The key is matched EXACTLY, never as a substring: `T-18` must not be held by `paseo-t-181` or an agent called
# `T-181 worker` (V12-08). A worktree's slug is its directory without `paseo-` or its name without `paseo/`; an
# agent carries the key when its directory is that worktree or a whole word of its title is the key.
live_workspace() {
  command -v "$PASEO" >/dev/null 2>&1 || return 1
  local found
  found="$("$PASEO" workspace ls --json 2>/dev/null | python3 -c '
import json, os, sys
key = sys.argv[1]
try: rows = json.load(sys.stdin)
except Exception: rows = []
for w in rows if isinstance(rows, list) else []:
    if str(w.get("isolation", "")).lower() != "worktree" or "archived" in str(w.get("status", "")).lower():
        continue
    base = os.path.basename(str(w.get("cwd") or "").rstrip("/")).lower()
    name = str(w.get("name") or "").lower()
    if base == "paseo-" + key or name == "paseo/" + key:
        print(w.get("workspaceId", "?"))
' "$KEY" 2>/dev/null)" || return 1
  [ -n "$found" ]
}

live_agent() {
  command -v "$PASEO" >/dev/null 2>&1 || return 1
  local found
  found="$("$PASEO" agent ls --json 2>/dev/null | python3 -c '
import json, os, re, sys
key = sys.argv[1]
try: rows = json.load(sys.stdin)
except Exception: rows = []
for a in rows if isinstance(rows, list) else []:
    if a.get("status") != "running":
        continue
    words = [w.strip(":,;()[]{}<>\"\x27") for w in re.split(r"\s+", str(a.get("name") or "").lower())]
    base = os.path.basename(str(a.get("cwd") or "").rstrip("/")).lower()
    if key in words or base == "paseo-" + key:
        print(a.get("id", ""))
' "$KEY" 2>/dev/null)" || return 1
  [ -n "$found" ]
}

# The lock is held for the whole check-and-write; it is never removed (removing a flock file races).
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "LOST another reservation holds the lock"
  exit 3
fi

if [ "$MODE" = "release" ]; then
  [ -n "$TOKEN_ARG" ] || { echo "LOST --release needs a token" >&2; exit 2; }
  if [ ! -f "$JSON" ]; then
    echo "LOST no reservation to release"
    exit 3
  fi
  CURRENT="$(json_token "$JSON")"
  if [ "$CURRENT" = "$TOKEN_ARG" ]; then
    rm -f "$JSON" 2>/dev/null
    if [ -e "$JSON" ]; then
      echo "LOST release-failed"
      exit 3
    fi
    echo "RELEASED $TOKEN_ARG"
    exit 0
  fi
  # A loser must never free a winner's reservation.
  echo "LOST token does not match the reservation"
  exit 3
fi

if is_fresh; then
  echo "LOST reserved at $(sed -n 's/.*"at"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$JSON" 2>/dev/null | head -n 1)"
  exit 3
fi
if live_workspace; then
  echo "LOST a live worktree carries $TASK"
  exit 3
fi
if live_agent; then
  echo "LOST a running agent carries $TASK"
  exit 3
fi

TOKEN="$(date -u +%s%N)-$$-${RANDOM}"
AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Written beside the target and renamed over it, then read back: a full disk or a read-only directory must
# not leave two dispatchers that both think they won while neither left a reservation behind.
STAGED="$JSON.tmp.$$"
if printf '{"task":"%s","token":"%s","pid":"%s","at":"%s"}\n' "$TASK" "$TOKEN" "$$" "$AT" >"$STAGED" 2>/dev/null &&
  [ "$(json_token "$STAGED")" = "$TOKEN" ] &&
  mv -f "$STAGED" "$JSON" 2>/dev/null &&
  [ -r "$JSON" ] && [ "$(json_token "$JSON")" = "$TOKEN" ]; then
  echo "WON $TOKEN"
  exit 0
fi
rm -f "$STAGED" 2>/dev/null
echo "LOST write-failed"
exit 3
