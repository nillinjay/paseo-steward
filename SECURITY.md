# Security model

This plugin supervises other repositories, so it is worth being explicit about what it does and does not protect.

## What the plugin may do

- Read a project's `plan.md`, `control/COMMAND.md`, `checks/tasks/*.json` and `checks/out/*.json`.
- Write its own configuration in `~/.paseo-steward.json` and its dispatch registry in `~/.paseo-steward-grants.json`.
- Answer Paseo permission requests for agents that belong to a supervised project, and dispatch agents through the
  `paseo` CLI.
- Start worker processes only through `paseo run`, inside their own worktrees.

It never writes to the repositories it supervises, apart from the delegation records a dispatcher is expected to write.

## What it does not do

- No network access of its own. No credential leaves the daemon host.
- It does not approve a shell command because the command "looks safe". Automatic shell approval ships **off**; a
  project may opt in, and every approval is audited.
- It does not decide that work is correct. A deterministic gate does, against a write scope, and only an artifact with
  provenance can count as accepted.

## Containment

`tools/sandbox/` wraps two providers in bubblewrap so a worker can only write to its own worktree, its agent state and
`/tmp`. `tools/sandbox/install.sh` installs and removes those wrappers.

## Known limitations (please read before running unattended)

- **One OpenCode server per machine.** OpenCode's sandbox binds every leg's worktree, so two concurrent OpenCode legs can
  write to each other's files. Prefer `claude-sbx` or `codex` for concurrent work, or run one leg at a time.
- **Git metadata breadth.** A leg's sandbox exposes the repository's git metadata so that it can commit; that includes a
  sibling worktree's index and the shared refs and hooks.
- **Peer messages are collaboration, not authorization.** A message can never widen a scope, change an owner, or stand
  in for a gate.

## Reporting

Open an issue titled `security:` with a repro. Please do not include secrets.
