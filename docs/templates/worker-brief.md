# Worker brief — canonical dispatch template

> Source: `DESIGN-V2.md` §6 (Manifest), §8 (communication) and §15.1–§15.5 (the red-team patches).
> Every dispatched worker gets this shape. Fields and reference paths only: no prose requirements, no
> requirement discussion, no history, no pasted documents.

```yaml
task_id: T-000                  # unique; matches the ledger row
lane: standard                  # fast | standard | parallel
tier: junior                    # junior | senior
profile: opencode/opencode-go/deepseek-v4.1-flash
risk: R1                        # R0 | R1 | R2
brief_kind: delivery            # delivery | reproduction | information | analysis | audit | incident
base: 0123456789abcdef0123456789abcdef01234567   # full 40-hex sha; never HEAD or a branch
write_scope:                    # the only paths the worker may change
  - path/one
  - path/two
forbidden:                      # paths and actions that must not be touched
  - path/three
ops_actions:                    # every non-git mutation; [] when there is none
  - cmd: "systemctl restart orders-api"
    reversible: yes             # yes | no
    # owner_ack_id: "owner-ack-2026-10-20-01"   # required when reversible: no
acceptance:                     # three kinds, not only "a command exited 0"
  - kind: cmd
    cmd: npx tsc --noEmit
  - kind: measurement
    cmd: node checks/metrics.cjs
    predicate:
      metric: first_pass_rate
      op: ">="                  # < | <= | > | >= | == | !=
      value: 0.8
      unit: ratio
      window: 2026-10-13..2026-10-20
      definition: "legs that passed Gate 1 on their first run / all legs dispatched"
      truncation: none          # exclusions, caps, dropped samples; write `none` explicitly
  - kind: external
    party: "ISO 27001 auditor"
expires_at: 2026-10-27T00:00Z   # ISO; required for external acceptance; null when no third party
# runbook: ops/runbooks/checkout-5xx.md   # incident only: the closed command set
p0_or_p1: P0                    # P0 mainline | P1 fill-valley
cancel_how: "P0: not withdrawn for P1; committed evidence stays on the branch until the leg closes"
reference:                      # paths only
  - path/to/spec
  - path/to/contract
```

## Rules

- **Fields only.** The brief carries no prose requirements, no prior discussion and no history.
- **`brief_kind` chooses the terminal outcome.** `delivery` → `DONE`; `analysis` → `NO-ANOMALY` when the
  check found nothing; `information` → `CLOSED-DISCARDED` when the answer is "this road is closed";
  `external` work that misses `expires_at` → `SOURCE_UNAVAILABLE`; `audit` → `EXTERNAL_ACCEPTANCE`.
  A brief without `brief_kind` is refused, because a successor cannot tell "deliver a change" from "give me
  a number".
- **`base` is a full 40-hex sha, never `HEAD` or a branch** whenever the artifact leaves the project. A short
  sha or a moving ref makes the reviewed artifact different from the integrated one.
- **`acceptance` has three kinds.** `cmd` must exit 0. `measurement` binds the command to a numeric
  predicate. `external:<party>` means an outside credential defines DONE. A measurement without `metric`,
  `op`, `value`, `window`, `definition` and `truncation` is not a measurement.
- **Every KPI has a definition.** State numerator/denominator, window and truncation rule in the predicate,
  or "first-pass rate" is two different numbers in two people's hands.
- **`ops_actions` makes non-git work visible.** Restarts, config changes and runbook steps are invisible to
  Gate 0's `git diff`. An action with `reversible: no` also needs an `owner_ack_id`.
- **`expires_at` ends third-party waits.** When it passes, the steward closes the leg as
  `SOURCE_UNAVAILABLE`, not `BLOCKED`.
- **`cancel_how` must not discard committed evidence.** A leg whose cancellation would throw away committed
  work is `P0` or `cancel_how: never`; only an uncommitted branch may be discarded.
- `p0_or_p1: P1` is refused without `cancel_how`. A P1 row is withdrawn the moment P0 needs its slot.
- `reference` carries paths, never pasted documents.
- A worker's own summary is not acceptance. The steward re-runs the declared acceptance.
- The worker reports with `docs/templates/worker-report.md` — four fields only.
- **Deliverable exemption.** When the owner asked for a document, the worker writes that document in full at
  `artifact_path`. The four-field rule governs the coordination report, not the deliverable.

## Incident briefs — the exception (R6)

An incident may stop the bleeding before it writes the record, under four limits:

- **Runbook only.** `runbook:` names the closed set; the worker runs only commands listed there, never an
  improvised one.
- **Destructive-verb denylist.** `rm -rf`, `DROP`, `reset --hard`, `push --force` are never covered by
  automatic shell approval. They need an explicit owner decision.
- **Irreversible actions need an owner ack id.** Every `reversible: no` entry in `ops_actions` carries
  `owner_ack_id`, or the brief is refused.
- **A retroactive decision brief within 24 h.** The steward records the mitigation, the exact command and
  the rollback path in `control/COMMAND.md` within one day.

## Where you run

- `lane: standard` / `parallel` → you are started in **your own worktree** (`paseo/<task_id>`, branched off the
  base sha you were given). Commit there. Do not touch the main tree.
- `lane: read-only` → you run in the main workspace and write exactly one file.
- Your teardown is part of the leg: once your branch is merged, the workspace is archived and the branch
  deleted. Do not archive it yourself.

## A review leg reads exactly one file: the packet

For a review, audit or analysis leg the steward builds `reviews/packet-<task>.md` with `tools/digest.sh`. Your
`read_scope` is that single file. Extracts are verbatim with `file:start-end` markers. If you need something
that is not in the packet, **name it and stop**; do not open the repository to look for it.

## Read budget — required, and it is small

    read_scope: <file>, <file>, <file>      # at most five, all named in this brief

- **No repo-wide search.** `rg`, `find`, `git log`, `ls -R` outside `read_scope` are out of budget. If you need
  something that is not on the list, **stop and report it**; the steward pastes the excerpt into the next brief.
- **One deliverable.** Code *or* a document, never both. Rationale goes in the commit message.
- Cheap by construction: an earlier leg read broadly on opus and cost 1.36 M cached tokens for one component.

## Tools you do not have

- **No browser, no GUI.** `chrome-use`, `google-chrome`, `chromium`, `firefox`, `xdg-open` are denied by policy.
  On 2026-10-20 a worker ran `chrome-use --session t113` to read Paseo docs and opened several real Chrome
  windows on the owner's desktop. If you need an external document, put its URL in your report; the steward
  fetches the excerpt and puts it in the next brief.
- **No network lookups unless the brief names a URL.** The project's own records are the source of truth.
- **Read only inside the project** plus the reference paths the brief names. Do not wander the home directory
  looking for AGENTS.md or skills: the ones that matter are in the brief.

## Owner-only questions — carried verbatim in every brief

Only these four may stop a worker and go to the owner:

- widening authorization beyond the standing grant
- changing the meaning of a criterion
- adding, removing or retiring a work item
- changing what the project is allowed to do

A `status: BLOCKED` report must name the class it is blocked on in `error: blocked_on=<class>`. A BLOCKED
report that names none of the four is rejected by the steward as a decision the worker failed to make.

If the answer is not one of these four, decide it yourself, record the decision in your report, and keep going.
