# paseo-steward

**One steward per project.** It watches a project's own records, keeps at most two implementation slots busy,
verifies work with a deterministic gate, and never asks you anything outside four classes.

Install → reload → open a project. `OVERVIEW.md` lists every surface and every warning. `plan.md` is the
contract; `DESIGN-V2.md` is the design; `control/COMMAND.md` is the live ledger.


## Sandbox: why a leg asks you for nothing

Three providers run legs on this machine, and two of them are contained by bubblewrap rather than by asking:

| provider | containment | install |
|---|---|---|
| `codex` | native `workspace-write` sandbox | built in |
| `claude-sbx` | `tools/sandbox/claude-sandboxed` wraps the real binary | `tools/sandbox/install.sh` |
| `opencode-sbx` | `tools/sandbox/opencode-global` sits on PATH in front of the real binary | `tools/sandbox/install.sh` |

Run the installer once per machine, then `paseo reload`:

```bash
tools/sandbox/install.sh              # records two provider overrides and repoints three profiles
tools/sandbox/install.sh --uninstall  # restores the previous config and the plain opencode binary
```

What a sandboxed leg can write: its own worktree, the git directories that worktree commits into, its agent state
directory, and `/tmp`. Everything else is read-only to it — `~/.ssh`, `~/.aws`, `/etc`, other projects.

Two limits worth knowing, both recorded in `plan.md`:

- OpenCode's server is one process for the whole machine, so its sandbox contains the machine but does not separate one
  leg from another.
- `/tmp` stays shared with the host because Paseo's own MCP helpers are spawned from an AppImage mount there.

## Install, run, verify

```bash
paseo plugin install /home/nil/code/paseo-steward   # first time only
paseo plugin reload  paseo-steward                  # after every edit
paseo plugin ls      paseo-steward                  # must read `running`
paseo plugin logs    paseo-steward                  # must reach `Plugin ready`, no error
```

`paseo plugin reload` also runs the deterministic suite first (`paseo.json` → `scripts.reload`), so a
regression cannot ship by the plugin merely loading.

## The three commands that matter

```bash
node checks/guard.cjs check --task <id> --base <sha> --commit <sha> --worktree <path> --registry .
node checks/accept.cjs <leg>          # writes checks/out/<leg>-<sha>.json
paseo usage                           # quota before anything expensive
```

A leg may be recorded as `accepted` only when the guard printed `SCOPE_PASS` **and** `GATE_PASS` and the
artifact's commit equals the commit being accepted. A passing gate is **not** a review.

## What it will not do

- Start a second steward while one is claimed (`state=held` + a live agent is enough).
- Answer a file write, a mode change or a grant. Those stay pending for you.
- Report "accepted" without an artifact.
- Count a read-only reviewer as an implementation slot.

## Layout

| Path | Holds |
|---|---|
| `server/` | the wheel, takeover, capitalist scan, permission policy, wake handler |
| `client/` | pill popover, workspace panel, sidebar, screen |
| `shared/` | Zod contracts and pure helpers (imported by both runtimes) |
| `checks/` | deterministic gates and one test per behaviour; `tasks/` holds manifests |
| `control/` | `COMMAND.md` (ledger + protocol), `RESUME.md` (one-screen hand-over) |
| `reviews/`, `redteam/` | independent verdicts and adversarial probes |

## Quotas

Junior work runs on the **free** opencode tier. `claude` keeps ≥ 30 % of its weekly quota and `codex` ≥ 20 %;
below a floor they are only used for takeover, review, merge and acceptance.
