# Architecture

Five parts, each with one job. The reason to keep them separate is that every review failure in this project's history
came from one part quietly doing another part's work.

```
                     ┌──────────────────────────┐
                     │  steward session          │  a Paseo agent, one per project
                     │  plans legs, merges,      │  decides WHAT and WHEN
                     │  answers what is left     │
                     └───────────┬──────────────┘
                                 │ dispatch (tools/dispatch.sh)
                     ┌───────────▼──────────────┐
                     │  worker in its own        │  codex / claude / opencode
                     │  git worktree             │  sandboxed or asking
                     └───────────┬──────────────┘
                                 │ commit + four-field report
                     ┌───────────▼──────────────┐
                     │  gate (checks/guard.cjs)  │  scope, acceptance commands, provenance
                     └───────────┬──────────────┘
                                 │ artifact guard-<task>-<sha>.json
                     ┌───────────▼──────────────┐
                     │  acceptance record        │  certified only with clean provenance
                     └──────────────────────────┘
```

## 1. The plugin (`index.server.ts`, `server/`, `shared/`, `client/`)

`server.before("agent.create")` is where a leg's environment is stated once: a **dispatch grant** recorded by the
dispatcher (outside the repository, so a worker cannot forge the terms of its own session) becomes provider options.
`server.on("agent.permission_requested")` is the only place a command is answered; when no grant covers it, the request
stays pending and a human sees it. `shared/` holds the Zod contracts and pure helpers and imports neither runtime — a
build rule enforced by `checks/leg48`.

## 2. The dispatcher (`tools/dispatch.sh`)

Locks, in order: the workstation is the authority for duplicate work; a model comes only from the profile roster; a
narrow profile may not receive a broad read list; a brief may not reach a worker with unsubstituted placeholders; a
`read_scope` file must exist in the base commit. It writes the task manifest itself (`tools/task-manifest.cjs`), takes an
atomic reservation (`tools/reserve.sh`, one winner among N concurrent attempts), and records the grant
(`tools/grant.cjs`).

## 3. The gate (`checks/guard.cjs`)

Compares the change against the manifest's `write_scope`, runs the acceptance commands, re-checks HEAD and cleanliness
afterwards, and writes an artifact carrying `provenance {clean, commit}`. It refuses to certify when the worktree HEAD is
not the commit under review. Artifacts live outside git on purpose: a leg that commits the guard's own evidence fails its
own scope check, which looks like a code problem.

## 4. Acceptance (`server/steward.ts` → `acceptanceState`)

`certified` requires `verdict PASS && scope.pass && gate.pass && commit in history && provenance.clean`. Anything else is
`legacy-artifact`, `legacy-accepted`, `unverified`, or `failed` — never a polite green. Two switches decide who acts on
it: **auto-accept** (verdict only, next step is yours) and **lazy mode** (the steward also plans).

## 5. The surface (`client/`)

The pill popover shows the steward's state, the workers, and a progress bar whose denominator is the project's own
milestones; the steward screen shows acceptance, the Ready queue and the pending permissions. Every `Text` is coloured
from `theme.colors` and padded from `layout.compact` so it reads on desktop and mobile, in both themes.

## Invariants worth keeping

- A claimed lease is a steward; a heartbeat proves recency, never existence.
- An unreadable list leaves a decision pending; it never becomes an allow.
- A manifest is a record, not backlog.
- Acceptance is an artifact whose commit is in history, or the leg is unverified.
- The reviewer's model family differs from the author's.
- One packet, one verdict, no finding without a repro.
