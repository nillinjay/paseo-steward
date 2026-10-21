#!/usr/bin/env bash
# Dispatch one task — through the OWNER'S ROSTER, never a hand-written model.
#
# Three locks, in order:
#   1. The workstation is the authority: a live worktree whose name contains the task id means the leg is out.
#   2. A model comes from the roster: `--role` names a PROFILE from the owner's employee list
#      (control/roster.json `profiles`, which must equal the daemon config's agentProfiles), and that profile
#      names provider/model. `--provider` / `--model` / `--thinking` are REFUSED here, because on
#      2026-10-20 a hand-written `claude/opus-4.6` — a model that does not exist — killed a leg silently.
#   3. The resolved triple is printed before the run, so the log shows what was actually asked for.
#
# Usage: tools/dispatch.sh <TASK_ID> --role <role> [--risk R0|R1|R2 --cancel-how <text> [--expires <ISO>]]
#          -- <paseo run args WITHOUT any provider/model...>
# With --risk / --cancel-how the dispatcher writes checks/tasks/<TASK_ID>.json itself (tools/task-manifest.cjs).
set -euo pipefail

TASK="${1:?usage: dispatch.sh <TASK_ID> --role <role> -- <paseo run ...>}"
shift
ROLE=""; RISK=""; CANCEL_HOW=""; EXPIRES=""; MANIFEST_FLAGS=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:?--role needs a value}"; shift 2 ;;
    --risk) RISK="${2:?--risk needs a value}"; MANIFEST_FLAGS=1; shift 2 ;;
    --cancel-how) CANCEL_HOW="${2:?--cancel-how needs a value}"; MANIFEST_FLAGS=1; shift 2 ;;
    --expires) EXPIRES="${2:?--expires needs a value}"; MANIFEST_FLAGS=1; shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
[ -n "$ROLE" ] || { echo "REFUSED: --role is required. The roster is the only source of a model." >&2; exit 4; }

for bad in --provider --model --thinking --mode; do
  for arg in "$@"; do
    if [ "$arg" = "$bad" ] || [ "${arg#"$bad"=}" != "$arg" ]; then
      echo "REFUSED: $bad is not allowed here. Roles pick models via control/roster.json." >&2
      echo "  roles: $(python3 -c 'import json,sys;print(", ".join(json.load(open(sys.argv[1]))["profiles"]))' "$(dirname "$0")/../control/roster.json")" >&2
      exit 4
    fi
  done
done

REPO="$(cd "$(dirname "$0")/.." && pwd)"
RESOLVED="$(node "$REPO/tools/roster.mjs" "$ROLE" "$REPO")" || exit 4
read -r PROVIDER MODEL THINKING PROFILE <<<"$(printf '%s' "$RESOLVED" | python3 -c '
import json,sys
r=json.load(sys.stdin)
print(r["provider"], r["model"], r.get("thinking") or "-", r["profile"])
')"

# The CLI: an explicit override, else whatever `paseo` resolves to, else a loud refusal. Never a personal path compiled in.
PASEO="${PASEO_BIN:-$(command -v paseo 2>/dev/null || true)}"
if [ -z "$PASEO" ]; then
  echo "REFUSED: no paseo CLI found. Put it on PATH or set PASEO_BIN." >&2
  exit 2
fi
command -v "$PASEO" >/dev/null 2>&1 || PASEO="paseo"
# Lock 3: a narrow profile (see control/roster.json budget) may not receive a broad read list. Reading is the
# dominant cost and it is not free over turns; the steward prepares a packet with tools/digest.sh instead.
NARROW="$(python3 - "$REPO" "$ROLE" <<'PY' 2>/dev/null || true
import json, sys
roster = json.load(open(sys.argv[1] + "/control/roster.json"))
entry = (roster.get("budget") or {}).get(sys.argv[2]) or {}
print("yes" if entry.get("narrow") else "no")
PY
)"
if [ "$NARROW" = "yes" ]; then
  BRIEF_TEXT="${!#}"
  SCOPE_LINE="$(printf '%s\n' "$BRIEF_TEXT" | grep -m1 '^read_scope:' || true)"
  if [ -n "$SCOPE_LINE" ]; then
    COUNT="$(printf '%s' "$SCOPE_LINE" | sed 's/^read_scope:[[:space:]]*//' | tr ',' '\n' | grep -c '[^[:space:]]' || true)"
    if [ "${COUNT:-0}" -gt 2 ]; then
      echo "REFUSED: $ROLE is a narrow profile and this brief lists $COUNT files to read." >&2
      echo "  Build the packet first: tools/digest.sh reviews/packet-<task>.md \"<what to judge>\" <file:start-end> ..." >&2
      echo "  then set read_scope: reviews/packet-<task>.md (one entry)." >&2
      exit 5
    fi
  fi
fi

# Lock 3a: a reviewer is paid for only after its packet passes tools/review-pack-validate.mjs. Twice on 2026-10-21 a
# reviewer answered "cannot determine" because the packet lacked an engine. Runs before the reservation, so a refusal
# leaves nothing behind.
case "$ROLE" in
  review-*)
    BRIEF_TEXT="${!#}"
    PACKETS="$(printf '%s\n' "$BRIEF_TEXT" | grep -m1 '^read_scope:' | sed 's/^read_scope:[[:space:]]*//' | tr ',' '\n' \
      | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -E '(^|/)packet[^/]*\.md$' || true)"
    if [ -z "$PACKETS" ]; then
      echo "REFUSED: $ROLE needs a review packet (reviews/packet-<task>.md from tools/digest.sh) on read_scope." >&2
      exit 9
    fi
    while IFS= read -r packet; do
      case "$packet" in /*) ;; *) packet="$REPO/$packet" ;; esac
      if ! node "$REPO/tools/review-pack-validate.mjs" "$packet" >&2; then
        echo "REFUSED: the review packet failed validation; rebuild it with tools/digest.sh." >&2
        exit 9
      fi
    done <<<"$PACKETS"
    ;;
esac

# Lock 3b: reserve the task id atomically. The old inline scan read the workspace list, then the agent list,
# then launched; two dispatches of the same task could both pass it. reserve.sh holds an flock over the whole
# check-and-write, so exactly one dispatch wins. The reservation is made BEFORE any workspace is created.
RESERVE_RC=0
RESERVE_OUT="$(RESERVE_REPO="$REPO" "$REPO/tools/reserve.sh" "$TASK")" || RESERVE_RC=$?
if [ "$RESERVE_RC" -ne 0 ]; then
  echo "REFUSED: $TASK is already out." >&2
  echo "  ${RESERVE_OUT:-reservation refused (exit $RESERVE_RC)}" >&2
  echo "The workstation is the authority. Finish it, archive it, or pick a new task id." >&2
  exit 3
fi
TOKEN="${RESERVE_OUT#WON }"
release_reservation() {
  [ -n "${TOKEN:-}" ] || return 0
  RESERVE_REPO="$REPO" "$REPO/tools/reserve.sh" --release "$TASK" "$TOKEN" >/dev/null 2>&1 || true
}

# Lock 4: a brief that still holds a placeholder has already cost two legs their whole turn. Refuse it here.
BRIEF_TEXT="${!#}"
if printf '%s' "$BRIEF_TEXT" | grep -qE '__TASK__|__BASE__|__DATE__'; then
  echo "REFUSED: the brief still contains an unexpanded placeholder (__TASK__ / __BASE__ / __DATE__)." >&2
  echo "  Substitute it first; a worktree is created from --base, so a stale placeholder is a dead leg." >&2
  release_reservation
  exit 6
fi

# Lock 5: every file on the brief's read_scope must exist IN THE BASE COMMIT.
# A worktree is created from --base, so a packet written but not committed is invisible to the worker, and the
# leg dies with "the only authorised input does not exist". Two review legs were lost that way (2026-10-20).
BRIEF_TEXT="${!#}"
SCOPE_LINE="$(printf '%s\n' "$BRIEF_TEXT" | grep -m1 '^read_scope:' || true)"
if [ -n "$SCOPE_LINE" ]; then
  BASE_SHA="$(printf '%s\n' "$BRIEF_TEXT" | sed -n 's/^base:[[:space:]]*\([0-9a-f]\{7,40\}\).*/\1/p' | head -1)"
  if [ -n "$BASE_SHA" ]; then
    MISSING=""
    for path in $(printf '%s' "$SCOPE_LINE" | sed 's/^read_scope:[[:space:]]*//' | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | grep -v '^$'); do
      case "$path" in /*|"") continue;; esac
      git -C "$REPO" cat-file -e "$BASE_SHA:$path" 2>/dev/null || MISSING="$MISSING $path"
    done
    if [ -n "$MISSING" ]; then
      echo "REFUSED: read_scope names files that are not in base $BASE_SHA:" >&2
      echo "  $MISSING" >&2
      echo "  Commit them first; the worker's worktree is created from that base." >&2
      release_reservation
      exit 7
    fi
  fi
fi

# Lock 6: the dispatcher owns the manifest. On 2026-10-21 three legs failed their gate because the worker wrote its
# own and guessed tier / brief_kind / expires_at / p0_or_p1. tools/task-manifest.cjs derives every key, refuses what
# it cannot derive, and writes the file atomically; only then does anything launch. Without manifest flags an
# existing manifest is used as-is, and a missing one is refused.
MANIFEST="$REPO/checks/tasks/$TASK.json"
if [ "$MANIFEST_FLAGS" = "1" ]; then
  MF_ARGS=(--task "$TASK" --role "$ROLE" --brief - --out "$MANIFEST")
  [ -n "$RISK" ] && MF_ARGS+=(--risk "$RISK")
  [ -n "$CANCEL_HOW" ] && MF_ARGS+=(--cancel-how "$CANCEL_HOW")
  [ -n "$EXPIRES" ] && MF_ARGS+=(--expires "$EXPIRES")
  if ! printf '%s\n' "$BRIEF_TEXT" | node "$REPO/tools/task-manifest.cjs" "${MF_ARGS[@]}" >/dev/null; then
    echo "REFUSED: could not write the manifest for $TASK (see the line above)." >&2
    release_reservation
    exit 10
  fi
elif [ ! -f "$MANIFEST" ]; then
  echo "REFUSED: no manifest for $TASK. Pass --risk and --cancel-how so the dispatcher writes checks/tasks/$TASK.json." >&2
  release_reservation
  exit 10
fi

echo "role=$ROLE profile=$PROFILE provider=$PROVIDER model=$MODEL thinking=$([ "$THINKING" = "-" ] && echo default || echo "$THINKING")"

# V1.2 phase 1: state the environment once, before the agent exists. The hook in server/grants.ts reads this record at
# `agent.create` and turns it into the provider's own sandbox options. The record lives outside the repository so a
# worker cannot forge the terms of its own session.
GRANT_ROLE="implement"
case "$ROLE" in review-*) GRANT_ROLE="review";; esac

# V12-05: the commands this leg may run without asking are snapshotted NOW, from the steward's own manifest, into the
# reservation record outside every worktree. The hook reads them from there; a worker editing the manifest inside its
# worktree changes nothing.
if ! python3 - "$REPO/.locks/$TASK.json" "$REPO/checks/tasks/$TASK.json" "$TOKEN" <<'PY'
import json, os, sys
lock_path, manifest_path, token = sys.argv[1:4]
with open(lock_path, encoding="utf-8") as fh:
    lock = json.load(fh)
if lock.get("token") != token:
    sys.exit(1)
try:
    with open(manifest_path, encoding="utf-8") as fh:
        commands = json.load(fh).get("allowed_commands") or []
except FileNotFoundError:
    commands = []
lock["allowed_commands"] = [c for c in commands if isinstance(c, str)]
tmp = f"{lock_path}.tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(lock) + "\n")
os.replace(tmp, lock_path)
PY
then
  echo "REFUSED: could not snapshot the declared commands into .locks/$TASK.json." >&2
  release_reservation
  exit 8
fi

# V12-04: a worktree's name is not its identity -- anyone can create `/tmp/x/paseo-t-100`. So the dispatcher creates
# the worktree itself, before the agent, writes the reservation token into it (`.steward-grant`), records the grant
# against the exact path the daemon returned, and only then starts the agent inside that workspace.
NEW_WS=""; WS_MODE=""; WS_SLUG=""; WS_NEW_BRANCH=""; WS_BASE=""; WS_BRANCH=""; WS_PR=""; WS_FORGE=""; SRC_CWD=""
RUN_ARGS=()
ARGV=("$@")
i=0
while [ "$i" -lt "${#ARGV[@]}" ]; do
  arg="${ARGV[$i]}"
  case "$arg" in
    --new-workspace|--worktree-mode|--worktree-slug|--new-branch|--base|--branch|--pr-number|--forge|--cwd)
      flag="$arg"; value="${ARGV[$((i + 1))]:-}"; i=$((i + 2)) ;;
    --new-workspace=*|--worktree-mode=*|--worktree-slug=*|--new-branch=*|--base=*|--branch=*|--pr-number=*|--forge=*|--cwd=*)
      flag="${arg%%=*}"; value="${arg#*=}"; i=$((i + 1)) ;;
    *)
      RUN_ARGS+=("$arg"); i=$((i + 1)); continue ;;
  esac
  case "$flag" in
    --new-workspace) NEW_WS="$value" ;;
    --worktree-mode) WS_MODE="$value" ;;
    --worktree-slug) WS_SLUG="$value" ;;
    --new-branch) WS_NEW_BRANCH="$value" ;;
    --base) WS_BASE="$value" ;;
    --branch) WS_BRANCH="$value" ;;
    --pr-number) WS_PR="$value" ;;
    --forge) WS_FORGE="$value" ;;
    --cwd) SRC_CWD="$value" ;;
  esac
done

WORKTREE=""
WS_ID=""
if [ "$NEW_WS" = "worktree" ]; then
  WS_ARGS=(workspace create --isolation worktree --path "${SRC_CWD:-$PWD}" --json)
  [ -n "$WS_MODE" ] && WS_ARGS+=(--mode "$WS_MODE")
  [ -n "$WS_SLUG" ] && WS_ARGS+=(--worktree-slug "$WS_SLUG")
  [ -n "$WS_NEW_BRANCH" ] && WS_ARGS+=(--new-branch "$WS_NEW_BRANCH")
  [ -n "$WS_BASE" ] && WS_ARGS+=(--base "$WS_BASE")
  [ -n "$WS_BRANCH" ] && WS_ARGS+=(--branch "$WS_BRANCH")
  [ -n "$WS_PR" ] && WS_ARGS+=(--pr-number "$WS_PR")
  [ -n "$WS_FORGE" ] && WS_ARGS+=(--forge "$WS_FORGE")
  WS_FIELDS="$("$PASEO" "${WS_ARGS[@]}" | python3 -c '
import json, os, sys
d = json.load(sys.stdin)
print(d["workspaceId"])
print(os.path.expanduser(d["cwd"]))
')" || WS_FIELDS=""
  WS_ID="$(printf '%s\n' "$WS_FIELDS" | sed -n 1p)"
  WORKTREE="$(printf '%s\n' "$WS_FIELDS" | sed -n 2p)"
  if [ -z "$WS_ID" ] || [ -z "$WORKTREE" ] || [ ! -d "$WORKTREE" ]; then
    echo "REFUSED: could not create the worktree for $TASK (paseo workspace create)." >&2
    release_reservation
    exit 9
  fi
  archive_workspace() { "$PASEO" workspace archive "$WS_ID" >/dev/null 2>&1 || true; }
  if ! printf '%s\n' "$TOKEN" >"$WORKTREE/.steward-grant"; then
    echo "REFUSED: could not write the grant token into $WORKTREE." >&2
    archive_workspace; release_reservation
    exit 8
  fi
  # The token file must never ride along in a commit: the gate would see a path outside write_scope.
  COMMON="$(git -C "$WORKTREE" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$COMMON" ] && ! grep -qxF '.steward-grant' "$COMMON/info/exclude" 2>/dev/null; then
    { mkdir -p "$COMMON/info" && printf '.steward-grant\n' >>"$COMMON/info/exclude"; } || true
  fi
  RUN_ARGS=(--workspace "$WS_ID" "${RUN_ARGS[@]}")
else
  # Not a worktree this dispatcher created: the agent runs in an existing tree. The grant can only name an explicit
  # --cwd exactly; with none, there is no path to grant and the leg keeps its profile's defaults.
  RUN_ARGS=("$@")
  [ -n "$SRC_CWD" ] && WORKTREE="$(cd "$SRC_CWD" 2>/dev/null && pwd)"
fi

if [ -n "$WORKTREE" ]; then
  node "$REPO/tools/grant.cjs" "$TASK" "$GRANT_ROLE" "$PROFILE" "$PROVIDER" "$WORKTREE" --token "$TOKEN" --locks "$REPO/.locks" || {
    echo "REFUSED: could not record the dispatch grant; an agent without terms is an agent that asks you for every step." >&2
    [ -n "$WS_ID" ] && archive_workspace
    release_reservation
    exit 8
  }
else
  echo "no grant: $TASK runs in an existing tree without --cwd" >&2
fi
EXTRA=()
[ "$THINKING" != "-" ] && [ -n "$THINKING" ] && EXTRA=(--thinking "$THINKING")
set +e
RUN_OUT="$("$PASEO" run --no-wait -q --provider "$PROVIDER" --model "$MODEL" "${EXTRA[@]}" "${RUN_ARGS[@]}")"
LAUNCH_RC=$?
set -e
[ -n "$RUN_OUT" ] && printf '%s\n' "$RUN_OUT"
# V12-09: record which agent IS this attempt, beside the reservation, so the peer channel can refuse a retired one.
AGENT_ID="$(printf '%s\n' "$RUN_OUT" | tail -n 1 | tr -d '[:space:]')"
if [ "$LAUNCH_RC" -eq 0 ] && [ -n "$AGENT_ID" ]; then
  python3 - "$REPO/.locks/$TASK.json" "$TOKEN" "$AGENT_ID" <<'PY' || echo "warning: could not record agent $AGENT_ID in .locks/$TASK.json; peer messages to $TASK will need it" >&2
import json, os, sys
lock_path, token, agent = sys.argv[1:4]
with open(lock_path, encoding="utf-8") as fh:
    lock = json.load(fh)
if lock.get("token") != token:
    sys.exit(1)
lock["agent"] = agent
tmp = f"{lock_path}.tmp"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(json.dumps(lock) + "\n")
os.replace(tmp, lock_path)
PY
fi
# A failed launch must not leave a reservation (or a fresh worktree) that blocks the retry for six hours.
if [ "$LAUNCH_RC" -ne 0 ]; then
  [ -n "$WS_ID" ] && archive_workspace
  release_reservation
fi
exit "$LAUNCH_RC"
