# Steward — a Paseo plugin that supervises a project

One steward per project. It dispatches work into per-leg git worktrees, verifies every leg with a deterministic gate,
accepts only what leaves an artifact with provenance, and asks a human nothing it can decide itself.

```bash
paseo plugin add <owner>/paseo-steward
paseo reload
```

Then open a project's steward screen and press **Onboard**: it creates the five files the steward reads, registers the
project with Paseo, and reports seven gates honestly. It never invents goals.

## What it actually does

| Surface | Behaviour |
|---|---|
| **Dispatch** | Reads `control/COMMAND.md`'s Ready queue, dispatches a leg into its own worktree through the owner's profile roster, and records a task manifest it owns — a worker never writes scheduler metadata |
| **Acceptance** | `checks/guard.cjs` checks the change against a write scope, runs the leg's acceptance commands, and writes `provenance {clean, commit}`. A PASS without provenance is never called verified |
| **Two switches** | **auto-accept** decides the verdict on work already dispatched and leaves the next step to you; **lazy mode** additionally plans and keeps the project moving |
| **Takeover** | A claim is a steward; heartbeat proves recency, never existence. The second identical logic failure hands the task to a senior on the same worktree and disqualifies the old attempt |
| **Peer channel** | Workers exchange high-density messages directly. A message cannot widen a scope, and a running peer is queued rather than interrupted |
| **Progress** | A bar whose denominator is the project's own milestones, with a current-work line — a manifest is a record, not backlog |

## Sandbox: why a leg asks you for nothing

`tools/sandbox/` puts a bubblewrap boundary around two providers so a worker can write only to its own worktree, its
agent state, and `/tmp`:

- `claude-sbx` — a daemon provider override whose command is `tools/sandbox/claude-sandboxed`
- `opencode-sbx` — an entry on `PATH` in front of the real binary, because Paseo resolves the shared OpenCode server
  through `PATH`

Inside an enforced sandbox, `bypassPermissions` removes clicks without removing containment. Codex needs none of this:
`approval_policy: never` plus `sandbox_mode: workspace-write` already gives zero prompts and a working commit.

```bash
tools/sandbox/install.sh              # records the overrides, repoints the profiles
tools/sandbox/install.sh --uninstall   # restores both
```

Automatic shell approval for a **non**-sandboxed provider ships **off**. A project may opt in; every approval is audited.

## Known limitations — read before running unattended

Stated here rather than buried in a changelog:

1. **OpenCode runs one server per machine**, so its sandbox binds every leg's worktree. Two concurrent OpenCode legs can
   reach each other's files. Prefer `claude-sbx` or `codex` for concurrent work, or run one leg at a time.
2. **Git metadata breadth.** A leg may write the git directories it commits into; for a linked worktree that includes
   the shared refs and hooks.
3. **Peer messages are collaboration, not authorization.** They never stand in for a gate.

`SECURITY.md` describes the model in full.

## Develop

```bash
npm ci
npx tsc --noEmit
./tools/suite.sh        # 49 checks, machine-local, no network
```

The suite is the contract: every finding a review ever raised is pinned by a check, and a check that cannot fail is
treated as decoration. `ARCHITECTURE.md` explains the moving parts and why each exists.

## Credits

- Built as a Paseo plugin against the official plugin API — before/after lifecycle hooks, provider overrides, and typed
  RPCs.
- **Supported by OpenAI's GPT-6.1 Sol**, which carried the long design and repair legs and, more than once, found the
  contradiction in a plan before any code was written.
- The supervision model absorbs the **dynamic-workflow ideas pioneered by Claude Code (cl)**: declare the work, let a
  machine verify it, and spend human attention only where judgement is genuinely required.
- The review discipline that shaped this repository — one packet, one verdict, no findings without a repro — is borrowed
  from the same tradition.

## License

MIT. See `LICENSE`.
