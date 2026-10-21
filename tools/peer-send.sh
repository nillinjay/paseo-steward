#!/usr/bin/env bash
# Peer-to-peer HCP delivery. Chat is collaboration, never authority.
#
# This is the audit entry point for worker-to-worker messages: it resolves the target from the same
# live workspace/agent lists dispatch uses, refuses any message that tries to move scope, ownership,
# a contract or a budget, and never interrupts a running turn for a routine message.
#
# Usage:
#   tools/peer-send.sh <FROM_TASK> <TO_TASK> --type <TYPE> \
#     --ref <file:line@sha|contract@sha|test-id> --need <one question> \
#     [--fact <one line>] [--impact <one line>]
#
# TYPE: ASK | FACT | CONFIRM | REVIEW | BLOCKED | DECISION_REQUEST
#
# Exit codes:
#   0  delivered (SENT) or queued for an idle checkpoint (QUEUED)
#   2  usage, malformed task id, unknown TYPE or missing --ref/--need
#   4  no manifest for TO_TASK, or no live agent for it (attempt gone); nothing sent
#   5  the message tries to change scope, ownership, a contract or a budget; nothing sent
#   1  delivery failed
#
# PASEO_BIN is honoured so checks can substitute a fake binary; the checks never start a real agent.
set -uo pipefail

REPO="${PEER_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"
PASEO="${PASEO_BIN:-paseo}"
command -v "$PASEO" >/dev/null 2>&1 || PASEO="paseo"

usage() {
  cat >&2 <<'EOF'
usage: tools/peer-send.sh <FROM_TASK> <TO_TASK> --type <TYPE> --ref <file:line@sha|contract@sha|test-id> --need <one question> [--fact <line>] [--impact <line>]
TYPE: ASK | FACT | CONFIRM | REVIEW | BLOCKED | DECISION_REQUEST
EOF
  exit 2
}

[ "${1:-}" = "--help" ] && usage
[ "$#" -ge 2 ] || usage
FROM="$1"
TO="$2"
shift 2

valid_task() {
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]*$'
}
valid_task "$FROM" && valid_task "$TO" || {
  echo "REFUSED: task ids must be simple identifiers (letters, digits, dot, underscore, dash)." >&2
  exit 2
}

TYPE=""
REF=""
NEED=""
FACT=""
IMPACT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --type)
      [ "$#" -ge 2 ] || usage
      TYPE="$2"
      shift 2
      ;;
    --ref)
      [ "$#" -ge 2 ] || usage
      REF="$2"
      shift 2
      ;;
    --need)
      [ "$#" -ge 2 ] || usage
      NEED="$2"
      shift 2
      ;;
    --fact)
      [ "$#" -ge 2 ] || usage
      FACT="$2"
      shift 2
      ;;
    --impact)
      [ "$#" -ge 2 ] || usage
      IMPACT="$2"
      shift 2
      ;;
    *)
      echo "REFUSED: unexpected argument: $1" >&2
      usage
      ;;
  esac
done

TYPE="$(printf '%s' "$TYPE" | tr '[:lower:]' '[:upper:]')"
case "$TYPE" in
  ASK|FACT|CONFIRM|REVIEW|BLOCKED|DECISION_REQUEST) ;;
  *)
    echo "REFUSED: --type must be one of ASK FACT CONFIRM REVIEW BLOCKED DECISION_REQUEST." >&2
    exit 2
    ;;
esac
[ -n "$REF" ] || { echo "REFUSED: --ref is required (file:line@sha, contract@sha or test-id)." >&2; exit 2; }
[ -n "$NEED" ] || { echo "REFUSED: --need is required (one precise question or action)." >&2; exit 2; }

# HCP is a one-line-per-field protocol. Fold accidental newlines rather than sending a wall of text.
one_line() {
  printf '%s' "$1" | tr '\r\n' '  ' | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//'
}
REF="$(one_line "$REF")"
NEED="$(one_line "$NEED")"
FACT="$(one_line "$FACT")"
IMPACT="$(one_line "$IMPACT")"

MANIFEST="$REPO/checks/tasks/$TO.json"
if [ ! -f "$MANIFEST" ]; then
  echo "REFUSED: no task manifest at checks/tasks/$TO.json; nothing sent." >&2
  exit 4
fi
python3 -c 'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))' "$MANIFEST" 2>/dev/null || {
  echo "REFUSED: checks/tasks/$TO.json is not valid JSON; nothing sent." >&2
  exit 4
}

# Scope, ownership, contract and budget changes are the steward's decision, not a peer's. Check before
# touching Paseo at all, so a refused attempt makes zero calls and leaves no trace in the inbox.
PEER_SCOPE_TEXT="$FROM $TO $TYPE $REF $FACT $NEED $IMPACT" python3 - <<'PY'
import os
import re
import sys

text = os.environ.get("PEER_SCOPE_TEXT", "").lower()
explicit = re.search(
    r"(^|[^a-z0-9_])(?:write[ _-]?scope|scope|ownership|contract|budget)\s*:",
    text,
)
key = re.search(r"\b(?:write[ _-]?scope|ownership|contract|budget)\b", text)
verb = re.search(
    r"\b(?:change|changed|changing|modify|modified|modifying|modification|update|updated|"
    r"updating|expand|expanded|widening|widen|extend|extended|reduce|reduced|increase|increased|"
    r"raise|raised|lower|lowered|add|added|adding|remove|removed|removing|delete|deleted|"
    r"deleting|drop|dropped|replace|replaced|rename|renamed|transfer|transferred|assign|assigned|"
    r"reassign|reassigned|move|moved|set|alter|altered|revoke|revoked|grant|granted|patch|patched)\b",
    text,
)
# A keyword and a change verb in the same sentence-sized window is a scope request, not a status report.
if explicit or (key and verb and abs(key.start() - verb.start()) <= 60):
    sys.exit(5)
sys.exit(0)
PY
SCOPE_RC=$?
if [ "$SCOPE_RC" -eq 5 ]; then
  echo "REFUSED: peer messages cannot change write_scope, ownership, a contract or a budget." >&2
  printf 'TYPE: DECISION_REQUEST | FROM: %s | TO: steward | REF: %s | NEED: %s\n' "$FROM" "$REF" "$NEED"
  exit 5
elif [ "$SCOPE_RC" -ne 0 ]; then
  echo "REFUSED: scope check failed; nothing sent." >&2
  exit 1
fi

AGENTS_FILE="$(mktemp "${TMPDIR:-/tmp}/peer-agents.XXXXXX")"
WORKSPACES_FILE="$(mktemp "${TMPDIR:-/tmp}/peer-workspaces.XXXXXX")"
cleanup() { rm -f "$AGENTS_FILE" "$WORKSPACES_FILE"; }
trap cleanup EXIT

if ! "$PASEO" agent ls --json >"$AGENTS_FILE" 2>/dev/null; then
  echo "REFUSED: \`paseo agent ls --json\` could not be read; no live target, nothing sent." >&2
  exit 4
fi
"$PASEO" workspace ls --json >"$WORKSPACES_FILE" 2>/dev/null || : >"$WORKSPACES_FILE"

# V12-09: the target is the CURRENT attempt, by exact task identity. Among live agents that belong to the task, the
# newest wins; when the dispatcher recorded the attempt's agent in .locks/<task>.json, the newest must be that agent,
# or nothing is sent. A tie with no record to break it is ambiguous and is refused too.
RESOLVED="$(python3 - "$AGENTS_FILE" "$WORKSPACES_FILE" "$TO" "$REPO/.locks/$TO.json" <<'PY'
import json
import os
import re
import sys
from datetime import datetime

agents_path, workspaces_path, task, registry_path = sys.argv[1:5]
key = task.lower()


def load(path):
    try:
        with open(path, encoding="utf-8") as fh:
            value = json.load(fh)
        return value if isinstance(value, list) else []
    except Exception:
        return []


def norm(path):
    path = os.path.expanduser(str(path or ""))
    return path.rstrip("/") or "/"


def slug_is_task(path):
    return os.path.basename(norm(path)).lower() == "paseo-" + key


def title_names_task(value):
    words = [w.strip(":,;()[]{}<>\"'") for w in re.split(r"\s+", str(value or "").lower())]
    return key in words


def age_seconds(agent):
    # `createdAt` when the CLI provides it; otherwise the relative `created` column ("just now", "3 minutes ago").
    stamp = agent.get("createdAt")
    if stamp:
        try:
            return (datetime.now().astimezone() - datetime.fromisoformat(str(stamp).replace("Z", "+00:00"))).total_seconds()
        except ValueError:
            pass
    text = str(agent.get("created") or "").lower()
    if text == "just now":
        return 0.0
    match = re.match(r"(\d+)\s+(minute|hour|day)s?\s+ago", text)
    if match:
        return float(match.group(1)) * {"minute": 60, "hour": 3600, "day": 86400}[match.group(2)]
    return None


# Exact identity: a worktree named paseo/<task> or living in paseo-<task>; `T-18` is not `T-18-old` or `T-181`.
workspace_cwds = {
    norm(w.get("cwd")) for w in load(workspaces_path)
    if str(w.get("name") or "").lower() == "paseo/" + key or slug_is_task(w.get("cwd"))
}
live = [a for a in load(agents_path) if str(a.get("status", "")).lower() in ("running", "idle")]
candidates = [
    a for a in live
    if norm(a.get("cwd")) in workspace_cwds or slug_is_task(a.get("cwd")) or title_names_task(a.get("name"))
]
if not candidates:
    sys.stderr.write(f"REFUSED: no live agent for {task} (attempt gone); nothing sent.\n")
    sys.exit(4)

recorded = ""
try:
    with open(registry_path, encoding="utf-8") as fh:
        recorded = str(json.load(fh).get("agent") or "")
except Exception:
    recorded = ""

ages = [age_seconds(a) for a in candidates]
if len(candidates) == 1:
    newest = candidates
elif all(age is not None for age in ages):
    youngest = min(ages)
    newest = [a for a, age in zip(candidates, ages) if age == youngest]
else:
    newest = candidates

if recorded:
    chosen = [a for a in newest if str(a.get("id") or "") == recorded]
    if not chosen:
        ids = ", ".join(str(a.get("id") or "?") for a in newest)
        sys.stderr.write(
            f"REFUSED: the current attempt for {task} resolves to {ids}, but the dispatcher recorded {recorded}; nothing sent.\n"
        )
        sys.exit(4)
    agent = chosen[0]
elif len(newest) == 1:
    agent = newest[0]
else:
    ids = ", ".join(str(a.get("id") or "?") for a in newest)
    sys.stderr.write(f"REFUSED: {task} has several live attempts ({ids}) and no recorded current one; nothing sent.\n")
    sys.exit(4)

agent_id = str(agent.get("id") or "")
if not agent_id:
    sys.stderr.write(f"REFUSED: the live agent for {task} has no id; nothing sent.\n")
    sys.exit(4)

print("\t".join([agent_id, str(agent.get("status") or "").lower(), norm(agent.get("cwd"))]))
PY
)"
RESOLVE_RC=$?
[ "$RESOLVE_RC" -eq 0 ] || exit 4
IFS=$'\t' read -r TARGET_ID TARGET_STATUS TARGET_CWD <<<"$RESOLVED"
[ -n "${TARGET_ID:-}" ] || { echo "REFUSED: target agent could not be resolved; nothing sent." >&2; exit 4; }

MESSAGE="$(printf 'TYPE: %s\nFROM: %s\nTO: %s\nREF: %s' "$TYPE" "$FROM" "$TO" "$REF")"
[ -n "$FACT" ] && MESSAGE="${MESSAGE}"$'\n'"FACT: ${FACT}"
MESSAGE="${MESSAGE}"$'\n'"NEED: ${NEED}"
[ -n "$IMPACT" ] && MESSAGE="${MESSAGE}"$'\n'"IMPACT: ${IMPACT}"

OUT="$REPO/checks/out"
mkdir -p "$OUT"
AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MSG_ID="${AT//[:]/}-$$-${RANDOM}"

# V12-10: the list above is a snapshot, and the target may have started a turn since. Look again immediately before
# delivering, and queue unless the target is confirmed idle right now (missing or unreadable counts as busy). The CLI
# has no conditional delivery -- `--behavior` is steer or interrupt -- so a turn that starts in the moment between
# this look and `paseo send` can still be steered; the window shrinks from the whole script to one process start.
if [ "$TARGET_STATUS" != "running" ]; then
  NOW_STATUS="$("$PASEO" agent ls --json 2>/dev/null | python3 -c '
import json, sys
try: rows = json.load(sys.stdin)
except Exception: rows = []
for a in rows if isinstance(rows, list) else []:
    if str(a.get("id") or "") == sys.argv[1]:
        print(str(a.get("status") or "").lower())
        break
' "$TARGET_ID" 2>/dev/null || true)"
  [ "$NOW_STATUS" = "idle" ] || TARGET_STATUS="running"
fi

if [ "$TARGET_STATUS" = "running" ]; then
  # Never interrupt a live turn for a routine message. The envelope is a checkpoint cache, not authority.
  PEER_INBOX="$OUT/peer-inbox-$TO.jsonl" \
  PEER_MSG_ID="$MSG_ID" PEER_FROM="$FROM" PEER_TO="$TO" PEER_AGENT="$TARGET_ID" \
  PEER_TYPE="$TYPE" PEER_REF="$REF" PEER_FACT="$FACT" PEER_NEED="$NEED" \
  PEER_IMPACT="$IMPACT" PEER_AT="$AT" PEER_VERDICT="QUEUED" \
  python3 - <<'PY'
import json
import os
import sys

row = {
    "message_id": os.environ["PEER_MSG_ID"],
    "project_id": "",
    "from_task": os.environ["PEER_FROM"],
    "to_task": os.environ["PEER_TO"],
    "agent_id": os.environ["PEER_AGENT"],
    "type": os.environ["PEER_TYPE"],
    "reference": os.environ["PEER_REF"],
    "fact": os.environ["PEER_FACT"],
    "need": os.environ["PEER_NEED"],
    "impact": os.environ["PEER_IMPACT"],
    "verdict": os.environ["PEER_VERDICT"],
    "at": os.environ["PEER_AT"],
}
with open(os.environ["PEER_INBOX"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
PY
  VERDICT="QUEUED"
  printf 'QUEUED\n'
else
  if ! "$PASEO" send "$TARGET_ID" --no-wait --behavior steer "$MESSAGE" >/dev/null; then
    echo "REFUSED: \`paseo send\` failed for $TARGET_ID; nothing recorded." >&2
    exit 1
  fi
  VERDICT="SENT"
  printf 'SENT\n'
fi

PEER_LOG="$OUT/peer-log.jsonl" \
PEER_FROM="$FROM" PEER_TO="$TO" PEER_TYPE="$TYPE" PEER_REF="$REF" \
PEER_VERDICT="$VERDICT" PEER_AT="$AT" \
python3 - <<'PY'
import json
import os

row = {
    "from": os.environ["PEER_FROM"],
    "to": os.environ["PEER_TO"],
    "type": os.environ["PEER_TYPE"],
    "ref": os.environ["PEER_REF"],
    "verdict": os.environ["PEER_VERDICT"],
    "at": os.environ["PEER_AT"],
}
with open(os.environ["PEER_LOG"], "a", encoding="utf-8") as fh:
    fh.write(json.dumps(row, ensure_ascii=False) + "\n")
PY

exit 0
