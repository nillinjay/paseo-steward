#!/bin/sh
# Retain executor evidence before its worktree is archived. Run from the destination repository.
set -eu
if [ "$#" -ne 2 ]; then
  echo 'usage: keep-artifact.sh <task> <worktree>' >&2
  exit 2
fi
case "$1" in ''|*[!a-zA-Z0-9_-]*) echo 'invalid task id' >&2; exit 2;; esac
root=$(git rev-parse --show-toplevel)
sha=$(git -C "$2" rev-parse --verify HEAD)
name="guard-$1-$sha.json"
source="$2/checks/out/$name"
if [ ! -f "$source" ]; then
  echo "artifact missing: $source" >&2
  exit 1
fi
mkdir -p "$root/checks/out"
if [ "$source" != "$root/checks/out/$name" ]; then
  cp -- "$source" "$root/checks/out/$name"
fi
printf '%s\n' "checks/out/$name"
