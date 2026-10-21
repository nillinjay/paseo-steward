#!/usr/bin/env bash
# Probe whether a worker can live inside a bubblewrap sandbox.
#
# Every sandbox in this script has the same shape:
#
#   bwrap --ro-bind / / --bind <tmp-worktree> <tmp-worktree> --dev /dev --proc /proc \
#         --tmpfs /tmp/scratch --unshare-pid --die-with-parent --chdir <tmp-worktree> -- <command>
#
# The host must already contain the /tmp/scratch mountpoint: `--ro-bind / /` makes
# /tmp read-only, so bwrap cannot create the mountpoint itself (it fails with
# "Can't mkdir /tmp/scratch: Read-only file system"). Creating it under /tmp is the
# only host write this probe performs, and the tmpfs hides whatever it held.
#
# Usage: tools/bwrap-probe.sh [all|git|escape|paseo|toolchain]
# Exit status is 0 only when every selected section exits 0.
set -uo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
bwrap_bin=${BWRAP:-bwrap}
paseo_bin=${PASEO_BIN:-paseo}
mode=${1:-all}

if ! command -v "$bwrap_bin" >/dev/null 2>&1; then
  echo "bwrap is not installed on this host (command: $bwrap_bin)" >&2
  exit 127
fi

scratch=/tmp/scratch
created_scratch=0
if [ ! -d "$scratch" ]; then
  mkdir -p "$scratch" || exit 1
  created_scratch=1
fi

worktree=$(mktemp -d /tmp/bwrap-probe-worktree.XXXXXX) || exit 1
outside="/tmp/bwrap-probe-outside-$$"
fail=0

cleanup() {
  rm -rf "$worktree"
  rm -f "$outside"
  if [ "$created_scratch" = 1 ]; then rmdir "$scratch" 2>/dev/null || true; fi
}
trap cleanup EXIT

quote_command() {
  local arg
  for arg in "$@"; do printf '%q ' "$arg"; done
  printf '\n'
}

# run_in_sandbox <worktree> <command...>
run_in_sandbox() {
  local wt=$1
  shift
  local cmd=("$bwrap_bin" --ro-bind / / --bind "$wt" "$wt" --dev /dev --proc /proc \
    --tmpfs /tmp/scratch --unshare-pid --die-with-parent --chdir "$wt" -- "$@")
  printf '$ '
  quote_command "${cmd[@]}"
  "${cmd[@]}"
  local code=$?
  printf 'exit=%s\n\n' "$code"
  return $code
}

# Control for question 3 only: identical shape minus the PID namespace, so the
# host daemon process is visible to the CLI.
run_without_pidns() {
  local wt=$1
  shift
  local cmd=("$bwrap_bin" --ro-bind / / --bind "$wt" "$wt" --dev /dev --proc /proc \
    --tmpfs /tmp/scratch --die-with-parent --chdir "$wt" -- "$@")
  printf '$ '
  quote_command "${cmd[@]}"
  "${cmd[@]}"
  local code=$?
  printf 'exit=%s\n\n' "$code"
  return $code
}

section_git() {
  echo '## 1. does a git worktree still work inside?'
  git -C "$worktree" init -q -b main
  git -C "$worktree" -c user.name=Probe -c user.email=probe@example.test \
    commit --allow-empty -q -m "probe base"
  run_in_sandbox "$worktree" git status --short --branch || fail=1
  run_in_sandbox "$worktree" sh -c \
    'printf "one\n" > probe.txt && git add probe.txt && git -c user.name=Probe -c user.email=probe@example.test commit -m "bwrap probe commit"' \
    || fail=1
  run_in_sandbox "$worktree" git log -1 --oneline || fail=1
}

section_escape() {
  echo '## 2. can a write escape to the host?'
  run_in_sandbox "$worktree" sh -c "printf 'escape\n' > '$outside'" || true
  if [ -e "$outside" ]; then
    echo "FAIL the write to $outside reached the host"
    fail=1
  else
    echo "PASS $outside does not exist on the host"
  fi
  echo

  run_in_sandbox "$worktree" sh -c \
    "printf 'scratch\n' > /tmp/scratch/probe.txt && cat /tmp/scratch/probe.txt" || fail=1
  if [ -e "$scratch/probe.txt" ]; then
    echo "FAIL /tmp/scratch/probe.txt leaked to the host filesystem"
    fail=1
  else
    echo "PASS /tmp/scratch is a private tmpfs; nothing leaked to $scratch on the host"
  fi
  echo
}

section_paseo() {
  echo '## 3. is the Paseo CLI usable inside?'
  if [ ! -x "$paseo_bin" ]; then
    echo "paseo binary not executable: $paseo_bin" >&2
    fail=1
    return
  fi
  run_in_sandbox "$worktree" "$paseo_bin" status --json || true
  echo 'control: the same command with --unshare-pid removed'
  run_without_pidns "$worktree" "$paseo_bin" status --json || true
}

section_toolchain() {
  echo '## 4. does the toolchain survive?'
  local repo_q
  repo_q=$(printf '%q' "$repo")
  run_in_sandbox "$worktree" sh -c \
    "cd $repo_q && node --version && npx tsc --noEmit && echo TSC_OK" || fail=1
}

case "$mode" in
  all) section_git; section_escape; section_paseo; section_toolchain ;;
  git) section_git ;;
  escape) section_escape ;;
  paseo) section_paseo ;;
  toolchain) section_toolchain ;;
  *) echo "usage: $0 [all|git|escape|paseo|toolchain]" >&2; exit 2 ;;
esac

exit "$fail"
