#!/usr/bin/env node
/**
 * LEG 17 acceptance — implementation slots and the slot-fill poke (review F7/F8).
 *
 * Two defects are proved fixed against a throwaway root, a temp config and a fake `paseo`:
 *
 *   a. Read-only reviewers in the main workspace consume no implementation slot. Two of them must
 *      leave both of the owner's slots free, the wheel must still poke, and the surface's
 *      `projectWorktrees` must be the worktree count (zero), never the running-agent count (two).
 *   b. A P1 row without `cancel_how` is not dispatchable: no poke, and a warning that names the row.
 *   c. A P1 row that does carry `cancel_how` is carried into the poke verbatim.
 *   d. P0 wins regardless of table order, and an ineligible P1 row beside it still warns.
 *   e. Every implementation instruction names the per-leg worktree, never "do not create a workspace".
 *
 * Nothing real is touched: no live agent, no supervised project, no dispatch.
 */
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { basename, join } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const BUNDLE = process.env.BUNDLE ?? "/tmp/steward-leg17-check.cjs";
const TMP = join(os.tmpdir(), `leg17-${process.pid}`);
const STEWARD = "aaaa1111-0000-4000-8000-000000000001";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function iso(minutesOffset) {
  return new Date(Date.now() + minutesOffset * 60_000).toISOString().slice(0, 16) + "Z";
}

function command(queueRows) {
  return [
    "# COMMAND", "",
    "## Lease", "",
    "    session=pi:test",
    `    paseo-agent=${STEWARD}`,
    "    since=2026-10-20T00:00Z",
    `    heartbeat=${iso(0)}`,
    "    state=held",
    "", "## Ready queue", "",
    "| task | p0_or_p1 | cancel_how |",
    "|---|---|---|",
    ...queueRows,
    "", "## Dispatch ledger", "",
  ].join("\n");
}

async function main() {
  if (!process.env.BUNDLE) execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + BUNDLE, "--external:@getpaseo/*",
  ], { cwd: REPO, stdio: "ignore" });

  mkdirSync(TMP, { recursive: true });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module")._initPaths();

  const fake = join(TMP, "fake-paseo");
  const pokeLog = join(TMP, "poke.log");
  const spawnLog = join(TMP, "spawn.log");
  const agentsFile = join(TMP, "agents.json");
  const workspacesFile = join(TMP, "workspaces.json");
  const permitsFile = join(TMP, "permits.json");
  writeFileSync(agentsFile, "[]");
  writeFileSync(workspacesFile, "[]");
  writeFileSync(permitsFile, "[]");
  writeFileSync(fake, `#!/bin/sh
case "$1 $2" in
  "agent ls") cat ${agentsFile};;
  "agent send") printf 'POKE %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> ${pokeLog};;
  "workspace ls") cat ${workspacesFile};;
  "permit ls") cat ${permitsFile};;
  *) printf 'SPAWN %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> ${spawnLog}; printf '{"id":"agent_test"}\\n';;
esac
`);
  chmodSync(fake, 0o755);

  const cfgPath = join(TMP, "config.json");
  process.env.PASEO_STEWARD_CONFIG = cfgPath;
  process.env.PASEO_BIN = fake;

  const project = (name, queueRows) => {
    const root = join(TMP, name);
    mkdirSync(join(root, "control"), { recursive: true });
    writeFileSync(join(root, "control", "COMMAND.md"), command(queueRows));
    return root;
  };
  const row = (root, patch = {}) => ({
    root, workspace: "wks_main", provider: "pi/test", thinking: "high",
    juniorProvider: "opencode/cheap-junior", intervalMinutes: 20, maxConcurrent: 2,
    nextTickAt: null, lastDispatchAt: null, lastPokeAt: null, lastPokeFingerprint: null,
    pokeFailureCount: 0, pokeFailureAgent: null, lazyMode: true, enabled: true,
    leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true, autoAllowShell: true, ...patch,
  });
  const writeConfig = (root) => writeFileSync(cfgPath, JSON.stringify({ projects: [row(root)], audit: [], auditEvictions: {} }, null, 2));
  const mainWorkspace = (root) => ({ project: basename(root), workspaceId: "wks_main", name: "main", isolation: "local", cwd: root });
  const worktree = (root, id) => ({ project: basename(root), workspaceId: id, name: id, isolation: "worktree", cwd: `${root}-${id}` });
  const pokes = () => (existsSync(pokeLog) ? readFileSync(pokeLog, "utf8").trim().split("\n").filter(Boolean) : []);
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean) : []);
  const fresh = () => { delete require.cache[require.resolve(BUNDLE)]; return require(BUNDLE); };

  // a. Two running read-only reviewers in the main workspace occupy no implementation slot.
  const rReviews = project("reviews", ["| T-impl | P0 | never |"]);
  writeFileSync(workspacesFile, JSON.stringify([mainWorkspace(rReviews)]));
  writeFileSync(agentsFile, JSON.stringify([
    { id: STEWARD, name: "the steward", cwd: rReviews, status: "running" },
    { id: "review-1", name: "review-codex (read-only)", cwd: rReviews, status: "running" },
    { id: "review-2", name: "read-only audit 2", cwd: rReviews, status: "running" },
  ]));
  writeConfig(rReviews);
  let m = fresh();
  const beforeReviews = pokes().length;
  await m.wheelPass("interval");
  const reviewState = await m.readSteward({ project: rReviews });
  check("two read-only reviewers in the main workspace leave both implementation slots free",
    pokes().length === beforeReviews + 1, `${pokes().length - beforeReviews} poke(s)`);
  check("the surface reports worktree slots, not the running-agent count",
    reviewState.workspaces.projectWorktrees === 0,
    `projectWorktrees=${reviewState.workspaces.projectWorktrees}`);
  check("a read-only review does not start a worker", spawns().length === 0, `${spawns().length} spawn(s)`);
  const reviewPoke = pokes().at(-1) ?? "";
  check("the slot-fill poke names the top P0 row", /T-impl/.test(reviewPoke), reviewPoke.slice(0, 120));
  check("the slot-fill poke requires a per-leg worktree", /worktree/i.test(reviewPoke), "worktree in the poke");

  // ...and an actual worktree is still counted, while the reviewers are not.
  writeFileSync(workspacesFile, JSON.stringify([mainWorkspace(rReviews), worktree(rReviews, "wks_wt1")]));
  writeFileSync(agentsFile, JSON.stringify([
    { id: STEWARD, name: "the steward", cwd: rReviews, status: "running" },
    { id: "review-1", name: "review-codex (read-only)", cwd: rReviews, status: "running" },
    { id: "impl-1", name: "T-impl worker", cwd: `${rReviews}-wks_wt1`, status: "running" },
  ]));
  writeConfig(rReviews);
  m = fresh();
  const oneWorktree = await m.readSteward({ project: rReviews });
  check("the worktree count includes only worktree workspaces",
    oneWorktree.workspaces.projectWorktrees === 1,
    `projectWorktrees=${oneWorktree.workspaces.projectWorktrees}`);

  // b. A P1 row without cancel_how must produce no dispatch instruction, and must warn.
  const rInvalidP1 = project("invalid-p1", ["| T-fill | P1 | |"]);
  writeFileSync(workspacesFile, JSON.stringify([mainWorkspace(rInvalidP1)]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "the steward", cwd: rInvalidP1, status: "running" }]));
  writeConfig(rInvalidP1);
  m = fresh();
  const beforeInvalid = pokes().length;
  const invalidResult = await m.wheelPass("interval");
  const invalidState = await m.readSteward({ project: rInvalidP1 });
  check("a P1 row with empty cancel_how produces no P1 dispatch instruction",
    pokes().length === beforeInvalid, `${pokes().length - beforeInvalid} poke(s)`);
  check("an ineligible P1 row is warned about in the wheel result",
    invalidResult.some((line) => /cancel_how/.test(line) && /T-fill/.test(line)),
    invalidResult.join(" · ") || "no result");
  check("an ineligible P1 row is warned about on the surface",
    invalidState.warnings.some((line) => /cancel_how/.test(line) && /T-fill/.test(line)),
    invalidState.warnings.join(" · ") || "no warning");

  // c. A P1 row that carries cancel_how is carried into the poke verbatim.
  const rEligibleP1 = project("eligible-p1", ["| T-valley | P1 | 撤回分支 paseo/T-valley |"]);
  writeFileSync(workspacesFile, JSON.stringify([mainWorkspace(rEligibleP1)]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "the steward", cwd: rEligibleP1, status: "running" }]));
  writeConfig(rEligibleP1);
  m = fresh();
  const beforeEligible = pokes().length;
  await m.wheelPass("interval");
  const eligiblePoke = pokes().at(-1) ?? "";
  check("an eligible P1 row is poked", pokes().length === beforeEligible + 1,
    `${pokes().length - beforeEligible} poke(s)`);
  check("the P1 cancellation requirement is carried into the poke",
    /T-valley/.test(eligiblePoke) && /撤回分支 paseo\/T-valley/.test(eligiblePoke),
    eligiblePoke.slice(0, 200));

  // d. P0 wins regardless of table order; the ineligible P1 beside it still warns, never dispatches.
  const rOrder = project("order", ["| T-p1-first | P1 | |", "| T-p0-second | P0 | never |"]);
  writeFileSync(workspacesFile, JSON.stringify([mainWorkspace(rOrder)]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "the steward", cwd: rOrder, status: "running" }]));
  writeConfig(rOrder);
  m = fresh();
  const beforeOrder = pokes().length;
  await m.wheelPass("interval");
  const orderPoke = pokes().at(-1) ?? "";
  check("a runnable P0 wins over a P1 that appears first", pokes().length === beforeOrder + 1 &&
    /优先派 P0 顶项：「T-p0-second」/.test(orderPoke), orderPoke.slice(0, 200));
  check("the skipped ineligible P1 is still named in the warning",
    /T-p1-first/.test(orderPoke) && /cancel_how/.test(orderPoke), orderPoke.slice(0, 200));

  // e. The old "do not create a workspace" instruction is gone everywhere it mattered.
  check("no poke forbids the worktree",
    ![reviewPoke, eligiblePoke, orderPoke].some((text) => /不要新建工作区/.test(text)),
    "no 'do not create a workspace' instruction");
  check("every implementation poke names a worktree",
    [reviewPoke, eligiblePoke, orderPoke].every((text) => /worktree/i.test(text)),
    "worktree present in all pokes");

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`} — ${pokes().length} poke(s), ${spawns().length} spawn(s)`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check crashed:", error);
  process.exit(2);
});
