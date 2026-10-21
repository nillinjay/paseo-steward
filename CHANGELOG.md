# Changelog

## 0.1.0

First public version.

- One steward per project: dispatch into per-leg worktrees, verify with a deterministic gate, accept only artifacts with
  provenance, take over only when no claim lives.
- Onboarding in one action, with seven gates reported honestly.
- Progress surface whose denominator is the project's own milestones.
- Two independent switches: **auto-accept** (the machine decides the verdict on work already dispatched, the user
  decides what comes next) and **lazy mode** (the steward also plans the next leg).
- Peer channel: high-density messages between workers, with a scope change refused and a running peer never interrupted.
- Two-strike takeover: the second identical logic failure hands the task to a senior on the same worktree.
- Sandbox wrappers for `claude` and `opencode` (`tools/sandbox/`), a dispatcher that owns the task manifest, and a
  review-packet precheck that refuses to pay a model for an incomplete packet.
