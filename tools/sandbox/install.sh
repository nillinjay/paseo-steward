#!/bin/sh
# Install (or remove) the sandbox that makes claude and opencode legs run without asking for permission.
#
# Two moving parts, both machine-level:
#   1. `~/.local/bin/opencode` becomes a symlink to tools/sandbox/opencode-global, because Paseo resolves the OpenCode
#      server through PATH and a daemon `command` override only affects its availability probe.
#   2. the daemon config gains a `claude-sbx` provider (extends claude) whose command is tools/sandbox/claude-sandboxed,
#      and `senior-opus` + `junior-a` + `junior-b` point at the sandboxed providers.
#
# Usage: tools/sandbox/install.sh [--home <paseo home>] [--uninstall]
set -eu

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
PASEO_HOME_DIR=""
MODE="install"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --home) PASEO_HOME_DIR="${2:?--home needs a path}"; shift 2;;
    --uninstall|--remove) MODE="uninstall"; shift;;
    *) echo "usage: install.sh [--home <paseo home>] [--uninstall]" >&2; exit 2;;
  esac
done
[ -n "$PASEO_HOME_DIR" ] || PASEO_HOME_DIR="${PASEO_HOME:-$HOME/.paseo}"
CONFIG="$PASEO_HOME_DIR/config.json"
# The PATH symlink is machine-wide. A rehearsal against a throwaway home must not touch it (it did once, and it
# silently switched the live sandbox off).
REAL_HOME="${PASEO_HOME:-$HOME/.paseo}"
TOUCH_PATH=1
[ "$(cd "$PASEO_HOME_DIR" 2>/dev/null && pwd)" = "$(cd "$REAL_HOME" 2>/dev/null && pwd)" ] || TOUCH_PATH=0
[ -f "$CONFIG" ] || { echo "no daemon config at $CONFIG" >&2; exit 2; }

command -v bwrap >/dev/null 2>&1 || echo "WARNING: bwrap is not installed; claude legs will refuse to start and opencode will run unsandboxed" >&2

if [ "$MODE" = "uninstall" ]; then
  if [ -L "$HOME/.local/bin/opencode" ] && [ "$TOUCH_PATH" = "1" ]; then
    rm -f "$HOME/.local/bin/opencode"
    [ -x "$HOME/.opencode/bin/opencode" ] && ln -sfn "$HOME/.opencode/bin/opencode" "$HOME/.local/bin/opencode"
  fi
  cp "$CONFIG" "$CONFIG.bak-uninstall-$(date +%Y%m%d-%H%M%S)"
  python3 - "$CONFIG" <<'PY'
import json, sys, pathlib
p = pathlib.Path(sys.argv[1]); c = json.loads(p.read_text())
for key in ("claude-sbx", "opencode-sbx", "opencode-sandboxed"):
    c.get("agents", {}).get("providers", {}).pop(key, None)
for profile in c.get("daemon", {}).get("agentProfiles", []):
    if profile.get("provider") in ("claude-sbx", "opencode-sbx"):
        profile["provider"] = "claude" if "claude" in profile["provider"] else "opencode"
p.write_text(json.dumps(c, ensure_ascii=False, indent=2) + "\n")
print("providers and profiles restored")
PY
  echo "uninstalled. Run 'paseo reload' to apply."
  exit 0
fi

# 1. opencode on PATH.
REAL_OPENCODE="$(readlink -f "$HOME/.local/bin/opencode" 2>/dev/null || true)"
case "$REAL_OPENCODE" in
  "$REPO"/*) ;;
  *) [ -n "$REAL_OPENCODE" ] && [ -x "$REAL_OPENCODE" ] && cp -a "$REAL_OPENCODE" "$HOME/.local/bin/opencode.real" 2>/dev/null || true;;
esac
if [ "$TOUCH_PATH" = "1" ]; then
  ln -sfn "$REPO/tools/sandbox/opencode-global" "$HOME/.local/bin/opencode"
else
  echo "rehearsal against $PASEO_HOME_DIR: leaving ~/.local/bin/opencode alone"
fi

# 2. providers and profiles.
cp "$CONFIG" "$CONFIG.bak-install-$(date +%Y%m%d-%H%M%S)"
python3 - "$CONFIG" "$REPO" <<'PY'
import json, sys, pathlib
config_path, repo = sys.argv[1], sys.argv[2]
p = pathlib.Path(config_path); c = json.loads(p.read_text())
providers = c.setdefault("agents", {}).setdefault("providers", {})
providers["claude-sbx"] = {
    "extends": "claude",
    "label": "Claude (bubblewrap sandbox)",
    "command": [f"{repo}/tools/sandbox/claude-sandboxed"],
}
providers["opencode-sbx"] = {
    "extends": "opencode",
    "label": "OpenCode (bubblewrap sandbox)",
    "command": [f"{repo}/tools/sandbox/opencode-sandboxed"],
}
for profile in c.get("daemon", {}).get("agentProfiles", []):
    if profile.get("name") == "senior-opus":
        profile["provider"] = "claude-sbx"
    if profile.get("name") in ("junior-a", "junior-b"):
        profile["provider"] = "opencode-sbx"
p.write_text(json.dumps(c, ensure_ascii=False, indent=2) + "\n")
print("providers claude-sbx/opencode-sbx installed; senior-opus, junior-a, junior-b point at them")
PY

echo "installed. Run 'paseo reload' to apply, then check: paseo provider ls | grep sbx"
