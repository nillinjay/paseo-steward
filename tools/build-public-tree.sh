#!/usr/bin/env bash
# Build the public release tree: the plugin, its checks, and the documents a stranger needs — and nothing else.
#
# The ledger (plan.md, STATUS.md, control/COMMAND.md as this project uses it, reviews/, output/, docs/ reports,
# AGENTS.md) stays private. The public tree gets TEMPLATES instead, so the layout is visible without publishing the
# project's own history.
#
# Usage: tools/build-public-tree.sh [<destination>]
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-/tmp/paseo-steward-public}"
[ "$DEST" = "$REPO" ] && { echo "refusing to build over the repository itself" >&2; exit 2; }

rm -rf "$DEST"; mkdir -p "$DEST"

for path in LICENSE README.md CHANGELOG.md SECURITY.md CONTRIBUTING.md ARCHITECTURE.md \
            package.json package-lock.json paseo-plugin.json OVERVIEW.md tsconfig.json \
            index.server.ts index.client.tsx .gitignore; do
  [ -e "$REPO/$path" ] && cp -a "$REPO/$path" "$DEST/"
done
# README.md is this project's working page; README.public.md is the one written for a stranger.
[ -e "$REPO/README.public.md" ] && cp -a "$REPO/README.public.md" "$DEST/README.md"
for dir in client server shared tools skills checks .github docs; do
  [ -d "$REPO/$dir" ] && cp -a "$REPO/$dir" "$DEST/"
done

# Never publish machine state or this project's own delegation history.
rm -rf "$DEST/checks/out" "$DEST/checks/tasks" "$DEST/.locks" "$DEST/node_modules" \
       "$DEST/docs/redteam" "$DEST/docs/design" "$DEST/docs/prompts"
mkdir -p "$DEST/docs/templates" "$DEST/control" "$DEST/checks/tasks"
for f in worker-brief.md worker-report.md; do
  [ -e "$REPO/docs/templates/$f" ] && cp -a "$REPO/docs/templates/$f" "$DEST/docs/templates/"
done
# Keep only the templates and the probe document from docs/.
find "$DEST/docs" -maxdepth 1 -type f ! -name 'templates' -delete 2>/dev/null || true
[ -e "$REPO/docs/V1.1-BWRAP-PROBE.md" ] && cp -a "$REPO/docs/V1.1-BWRAP-PROBE.md" "$DEST/docs/"

# Templates that show the expected layout without the project's own content.
cat > "$DEST/plan.md" <<'EOF'
# Project plan (template)

**Contract.** What was promised, what was decided, and why. The steward reads this file; nothing else is authoritative.

## Milestones

*The single honest denominator for the progress bar. `[x]` means the gate is met and checkable, not that someone felt
finished.*

- [ ] M1 describe the first outcome a stranger could verify
- [ ] M2 describe the second
EOF

cat > "$DEST/control/COMMAND.md" <<'EOF'
# Command ledger (template)

The live state of the project: what may be dispatched next, what is blocked, and who owns each decision.

## Ready queue (what may be dispatched next, in order)

**Three items, not ten.** Completed rows are deleted, not kept.

| # | task | role | depends on |
|---|---|---|---|
| 1 | **T-001 — first leg** | `junior-a` | — |
| 2 | T-002 — second leg | `senior-sol` | T-001 merged |

## Only the owner may decide these four

1. widening authorization beyond the standing grant
2. changing the meaning of a criterion
3. adding, removing or retiring a work item
4. changing what the project is allowed to do

## Unattended operation

- **auto-accept** decides the verdict on work already dispatched; the next step stays a human decision.
- **lazy mode** additionally plans and keeps the project moving. It requires auto-accept.
- The reviewer's model family must differ from the author's.
EOF

python3 - "$DEST" <<'PY'
import json, pathlib, sys
dest = pathlib.Path(sys.argv[1])
profiles = ["pi-总管", "junior-a", "junior-b", "senior-sol", "senior-opus", "review-codex", "review-gemini"]
roster = {
  "template": True,
  "_comment": "Example roster. Roles are the only names a dispatch may use; the dispatcher refuses a hand-written model.",
  "profiles": profiles,
  "routing": {"steward": "pi-总管", "implementation": "junior-a", "implementation-second-model": "junior-b",
              "senior": "senior-sol", "ui": "senior-opus", "review": "review-codex",
              "review-alternate-family": "review-gemini"},
  "budget": {name: {"narrow": name.startswith("review-"), "max_cached_tokens": 120000} for name in profiles},
}
(dest / "control/roster.json").write_text(json.dumps(roster, ensure_ascii=False, indent=2) + "\n")
for tid, tier in (("T-001", "junior"), ("T-002", "senior")):
    (dest / f"checks/tasks/{tid}.json").write_text(json.dumps({
        "task_id": tid, "lane": "standard", "risk": "R0" if tier == "junior" else "R1", "base": "0" * 40,
        "write_scope": ["checks/"], "forbidden": ["docs/"], "ops_actions": [], "allowed_commands": [],
        "acceptance": [{"kind": "cmd", "cmd": "npx tsc --noEmit"}],
        "tier": tier, "p0_or_p1": "P0", "brief_kind": "delivery", "expires_at": None, "reference": [],
        "cancel_how": "example manifest — the base is a placeholder",
    }, ensure_ascii=False, indent=2) + "\n")
print("templates written")
PY

# Nothing published may name a person's home directory. Prose (a probe record quoting the machine it ran on) is
# rewritten to /home/dev/. Code is never rewritten, because the tree that is published must be the tree that was tested,
# so a personal path in code stops the build. The other names are placeholders the fixtures and comments use.
# checks/leg55-public-tree.cjs holds the same rule.
python3 - "$DEST" <<'PY'
import pathlib, re, sys
dest = pathlib.Path(sys.argv[1])
placeholders = {"dev", "example", "owner", "other", "private"}
personal = re.compile(r"/home/([A-Za-z0-9._-]+)/")
scrub = lambda m: m.group(0) if m.group(1) in placeholders else "/home/dev/"
dirty = []
for f in sorted(p for p in dest.rglob("*") if p.is_file()):
    try:
        text = f.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    if f.suffix == ".md":
        clean = personal.sub(scrub, text)
        if clean != text:
            f.write_text(clean, encoding="utf-8")
            print(f"scrubbed home paths in {f.relative_to(dest)}")
        continue
    for n, line in enumerate(text.splitlines(), 1):
        if any(m.group(1) not in placeholders for m in personal.finditer(line)):
            dirty.append(f"{f.relative_to(dest)}:{n}: {line.strip()}")
if dirty:
    print("refusing to publish a personal home path:", *dirty, sep="\n  ", file=sys.stderr)
    sys.exit(1)
PY

echo "built $DEST"
du -sh "$DEST"
