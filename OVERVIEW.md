# paseo-steward

Pipeline supervision for Paseo-orchestrated projects, **isolated per project**. Read-only towards the
projects; it never edits them.

## One steward per project, in one workspace

The owner's rule: *every project gets its own steward, and each steward lives in exactly one workspace.*
So:

- **Projects are discovered from Paseo itself.** A `local` workspace points at a project directory, so each
  such workspace is registered as a project and **becomes that project's designated steward workspace**.
  Nothing has to be configured by hand; open the panel on a new project and it is already there.
- **The tick is per project.** When enabled, each project's lease is read independently and a steward is
  dispatched **into that project's own workspace** with `paseo run --workspace <id>`. A project with no
  workspace set cannot be enabled — the tick refuses rather than risk creating a new workspace per run.
- **A project with no `control/COMMAND.md` is reported as not onboarded**, with no warnings: it is simply
  not managed by this protocol yet.

## Surfaces

| surface | scope |
|---|---|
| **Composer pill** `Steward` | in every agent's composer, beside Tasks and Subagents, showing **that agent's project**. A dot says whether the steward is alive (green filled: alive with workers out; green ring: alive and idle; amber ring: stale; grey ring: no steward), and `Steward · 2` counts the workers running now (live agents in the project's workspaces, steward sessions excluded; never the dispatch ledger). Pressing it opens a popover with those two facts and one action: hand the steward over (when it is stale) or open the Steward screen |
| **Workspace panel** | beside agents and diffs on the project workspace: the same two facts, then the questions waiting on you and any warnings |
| **Sidebar footer row** | across every onboarded project: the dot of the project that most needs attention, and the total workers running |
| **Screen** `Steward`, ⌘K item, `/steward` | full detail for one project, with a project picker: the two facts, questions waiting on you, current batch, lease, capacity, and a separate **History** section for past dispatches and merges, which is never counted as current |

## What it reads

Everything comes from the projects' own durable files, so the view cannot drift from the record:

`control/COMMAND.md` (lease + dispatch ledger) · `control/MERGES.md` · `control/WAVES.md` (current batch) ·
`output/status-one-pager.md` (the batched owner questions, verbatim) · `runs/ledger.jsonl` ·
`env/refs.env` + git (project and **solver fork** branch/head/dirty) · `paseo workspace ls --json`
(worktree slot occupancy, and stray local workspaces).

Every number shown is current state. Dispatch rows that were stopped and later resolved stay in the
history and are not counted as open problems.

## Warnings, each one tied to a real incident

- **lease heartbeat in the future** — never looks stale, so the handover would silently never happen.
- **lease looks stale** — a successor may claim it.
- **more than one local workspace at a project root** — the steward belongs in exactly one. `paseo schedule`
  creates a **new workspace per run**, which is why this plugin owns the tick instead.
- **fewer than three of five worktree slots in use** — count slots before the next dispatch.
- **dirty project tree / dirty fork** — a fork leg is mid-write; no other fork writer may start.
- **N agents are idle with a pending request** — the turn cannot close and no completion notification is
  sent. Leg 22 sat an hour this way holding a `request_user_input_async` after printing its final report.

## Dispatch and report

The steward is a manager: it dispatches, it does not implement. Low communication cost is enforced by shape,
not by asking people to be brief:

- **Manifest in.** Every worker brief follows `docs/templates/worker-brief.md`: `task_id`, `lane`, `tier`,
  `risk`, `base`, `write_scope`, `forbidden`, `acceptance`, `p0_or_p1`, `cancel_how`, and `reference` paths.
  Fields and paths only — no prose requirements, no requirement discussion, no history. A `P1` brief without
  `cancel_how` is refused.
- **Four fields out.** Every worker report follows `docs/templates/worker-report.md`: `status`,
  `commit_sha`, `artifact_path`, and `error_code + first_root_cause + log_path`. No narrative. The steward
  re-runs the declared acceptance; "the worker said DONE" is not DONE.
- **Deliverables are exempt.** A document the owner asked for is written in full; the four-field rule
  governs the coordination message, not the deliverable.

The steward's own dispatch prompt (`RESUME_PROMPT`, `server/steward.ts`) is manifest-shaped for the same
reason, and the wake message sent on `agent.turn_ended` asks for the same four fields.

## Permission policy

`agent.permission_requested` is answered for agents in a steward project's workspaces, three cases only:

| request | answer | toggle |
|---|---|---|
| `ExitPlanMode` (kind `plan`) | `allow` | `autoAllowPlanExit`, default on |
| a question (`request_user_input_async`, `AskUserQuestion`, kind `question`) | `deny` with a message telling the agent to end its turn and put the question in its report | `autoDenyQuestions`, default on |
| a shell command (`CodexBash`, `Bash`, …) | `allow` — **measured**: two codex workers each sat 25 minutes on one pending `CodexBash`; a worker that must ask a human for every command cannot work unattended | `autoAllowShell`, default on |
| anything else — file write, mode change, grant | **left pending for the human**, always | none |

Every automatic answer, including a failed one, is appended to `audit` in the config file (newest first,
capped at 200) and shown on the screen under `Automatic answers`. Requests raised before the plugin loaded
are not seen by the event; the screen's `Answer pending by policy` (`answer-pending`) applies the same
policy to them.

## 懒人模式 (lazy mode)

One switch in the pill's popover, beside 打开总管. **Off by default.**

- **Off** is inert: nothing automatic happens; 立即接管 is the only way anything starts.
- **A claimed lease IS a steward (owner ruling).** Existence is the claim plus a matching agent in Paseo; the
  heartbeat is recency only. An old heartbeat must never read as "lost" and must never start a duplicate.
- **接管 instead of hand-over.** A steward is started only when the project has none: no claim, or a claim
  naming an agent Paseo no longer has. Auto hand-over was ruled a pseudo-need — it pays a cold start to
  replace a session that already exists.
- **A released block starts nobody, and a lawful 接管 waits out the floor.** `state=released` is a state, not
  a summons: a released block whose session is still running dispatches nothing. When the claim names an
  agent Paseo no longer has, the dispatch happens at the first beat at or after `lastDispatchAt + 2 min`, so
  the real bound is **≤ floor + one beat = 150 s** from the previous dispatch, never 30 s.
- **Cheap first.** The capitalist sends the cheapest capable worker, not the best one. Tier 0 is the
  project's `juniorProvider`, a `harness/model` pair: by default `opencode/opencode-go/deepseek-v4.1-flash`,
  because juniors run on the **opencode harness** and pi's harness belongs to the steward (owner ruling).
  Tier 0 covers exploration, reproductions, analysis, docs, tests, translation. Escalate to a
  senior model only for genuine risk (permission boundaries, concurrency, data migration) or after a junior
  fails twice — and the reason is written into the project ledger. The slot-scan poke names the junior
  provider, because habit otherwise reaches for the expensive model.
- **The capitalist rule.** Every five minutes the plugin checks the worktree slots. Free slots plus a
  non-empty Ready queue means the steward is wasting money, so it gets **one poke** to the same session
  (`--behavior steer`), never a new agent. An empty queue means no poke at all.
- **A finished worker wakes the same session.** `agent.turn_ended` → one coalesced line naming the worker and
  its outcome. Measured 2026-10-19: same agent id, `CachedTokens` 6 144 → 29 312, so a wake is a cached turn.
- **The steward is a manager, not an engineer**: align the requirement, cut the legs, dispatch about three
  juniors in parallel when their write sets do not overlap, and verify by artifact. It does not implement.
- **Only the four owner-only classes stop it**: widening authorization, changing a criterion's meaning,
  adding/removing/retiring a work item, changing what the project may do.

## Tick

Disabled by default. `steward.control` actions: `set-lazy`, `enable`, `disable`, `set-interval`, `set-workspace`,
`tick-now`, `archive-stray`, `forget-project`, `set-policy` (`policy` = `plan` | `question`, `on`),
`answer-pending`. The lease is the mutex, so the tick only dispatches when a
project's lease is genuinely stale; two stewards for one project cannot run at once. The cadence must exceed
the lease's stale window (default 20 min vs 15 min).

Config: `${PASEO_STEWARD_CONFIG:-~/.paseo-steward.json}` — `{ projects, audit }`: per-project entries and
the permission audit, written by the plugin. Environment overrides: `PASEO_STEWARD_PROVIDER`, `PASEO_STEWARD_THINKING`,
`PASEO_STEWARD_INTERVAL_MIN`, `PASEO_STEWARD_LEASE_MIN`, `PASEO_BIN`.

## Notes

- No network access of its own; credentials never leave the daemon host.
- `readSteward` / `readProjects` are pure over files plus `git` and the `paseo` CLI, so they can be
  exercised standalone. That is how these were found: `\Z` is **not** a JavaScript escape (it matched a
  literal `Z` inside `since=…T07:51Z` and truncated the lease block), and project worktrees do not live
  under the project path, so they must be matched by the `project` field rather than by cwd.
