#!/usr/bin/env node
/**
 * LEG 40 — the R0 gate runs inside the existing tick, and status reports real wait/cycle time.
 *
 * The contract under test:
 *   1. A worker reports DONE with a full commit and an R0 manifest. The tick, with 懒人模式 OFF, runs
 *      checks/guard.cjs for that commit. A clean, in-scope commit is recorded PASS with a Guard artifact.
 *   2. An out-of-scope commit is recorded FAIL and the task is not accepted. A failed commit is never
 *      retried by the next tick.
 *   3. An R1 task in the same state is not captured or gated automatically; it still waits for a human.
 *   4. Per-task `permissionWaitMs` sums request-to-decision intervals from persisted audit rows, and
 *      `cycleMs` is first audit entry to acceptance. Older rows without a request time contribute 0.
 *
 * Throwaway roots, temp git repos, a fake `paseo` binary and a fake config. Nothing real is touched.
 */
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, mkdtempSync } = require("node:fs");
const { join, basename } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const TMP = mkdtempSync(join(os.tmpdir(), "leg40-"));
const BUNDLE = join(TMP, "server.cjs");
const CFG = join(TMP, "config.json");

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}
const git = (cwd, args, allowEmpty = false) => execFileSync("git", [
  "-c", "user.name=Probe", "-c", "user.email=probe@example.test", ...args,
  ...(allowEmpty ? ["--allow-empty"] : []),
], { cwd, encoding: "utf8" }).trim();

function repoAt(root, initial = true) {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-q"]);
  if (initial) git(root, ["commit", "-q", "-m", "base"], true);
  return git(root, ["rev-parse", "HEAD"]);
}

function commitFile(root, name, body, message) {
  writeFileSync(join(root, name), body);
  git(root, ["add", name]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function manifest(task, risk, base) {
  return {
    task_id: task, lane: "standard", risk, base,
    write_scope: ["allowed.txt"],
    forbidden: ["client/", "tools/", "docs/", "plan.md", "control/"],
    acceptance: [{ kind: "cmd", cmd: "true" }],
    tier: "junior", p0_or_p1: "P0", brief_kind: "delivery",
    expires_at: null, ops_actions: [], reference: [], cancel_how: "leg40 fixture",
  };
}

const root = join(TMP, "project");
mkdirSync(join(root, "control"), { recursive: true });
mkdirSync(join(root, "checks", "tasks"), { recursive: true });
mkdirSync(join(root, "checks", "out"), { recursive: true });
writeFileSync(join(root, "control", "COMMAND.md"), [
  "# COMMAND", "", "## Lease", "",
  "    session=probe", "    paseo-agent=", "    since=2026-10-20T00:00Z",
  "    heartbeat=2026-10-20T00:00Z", "    state=held", "", "## Dispatch ledger", "",
].join("\n"));
repoAt(root);
writeFileSync(join(root, "checks", "tasks", "T-METRIC.json"), JSON.stringify(
  manifest("T-METRIC", "R0", git(root, ["rev-parse", "HEAD"]))));
git(root, ["add", "-A"]);
git(root, ["commit", "-q", "-m", "metric manifest"]);
const rootHead = git(root, ["rev-parse", "HEAD"]);

// Three independent worktrees, so a failure in one cannot contaminate another.
const passWt = join(TMP, "pass");
const failWt = join(TMP, "fail");
const r1Wt = join(TMP, "r1");
const passBase = repoAt(passWt);
const failBase = repoAt(failWt);
const r1Base = repoAt(r1Wt);
const passCommit = commitFile(passWt, "allowed.txt", "in scope\n", "pass");
const failCommit = commitFile(failWt, "outside.txt", "out of scope\n", "fail");
const r1Commit = commitFile(r1Wt, "allowed.txt", "in scope\n", "r1");

writeFileSync(join(root, "checks", "tasks", "T-R0-PASS.json"), JSON.stringify(manifest("T-R0-PASS", "R0", passBase)));
writeFileSync(join(root, "checks", "tasks", "T-R0-FAIL.json"), JSON.stringify(manifest("T-R0-FAIL", "R0", failBase)));
writeFileSync(join(root, "checks", "tasks", "T-R1-HUMAN.json"), JSON.stringify(manifest("T-R1-HUMAN", "R1", r1Base)));

const PASS_AGENT = "aaaa1111-0000-4000-8000-000000000001";
const FAIL_AGENT = "bbbb2222-0000-4000-8000-000000000002";
const R1_AGENT = "cccc3333-0000-4000-8000-000000000003";
const agentsFile = join(TMP, "agents.json");
const workspacesFile = join(TMP, "workspaces.json");
writeFileSync(agentsFile, JSON.stringify([
  { id: PASS_AGENT, name: "pass worker", title: "worker T-R0-PASS", cwd: passWt, status: "idle" },
  { id: FAIL_AGENT, name: "fail worker", title: "worker T-R0-FAIL", cwd: failWt, status: "idle" },
  { id: R1_AGENT, name: "r1 worker", title: "worker T-R1-HUMAN", cwd: r1Wt, status: "idle" },
]));
writeFileSync(workspacesFile, JSON.stringify([
  { project: basename(root), workspaceId: "wks_probe", name: "main", isolation: "local", cwd: root },
  { project: basename(root), workspaceId: "wks_probe", name: "pass", isolation: "worktree", cwd: passWt },
  { project: basename(root), workspaceId: "wks_probe", name: "fail", isolation: "worktree", cwd: failWt },
  { project: basename(root), workspaceId: "wks_probe", name: "r1", isolation: "worktree", cwd: r1Wt },
]));

const fake = join(TMP, "fake-paseo");
writeFileSync(fake, `#!/usr/bin/env node
const fs = require("node:fs");
const sub = process.argv.slice(2, 4).join(" ");
if (sub === "workspace ls") process.stdout.write(fs.readFileSync(${JSON.stringify(workspacesFile)}, "utf8"));
else if (sub === "agent ls") process.stdout.write(fs.readFileSync(${JSON.stringify(agentsFile)}, "utf8"));
else process.stdout.write("[]");
`);
chmodSync(fake, 0o755);

process.env.PASEO_STEWARD_CONFIG = CFG;
process.env.PASEO_BIN = fake;
process.env.PASEO_STEWARD_GUARD = join(REPO, "checks", "guard.cjs");
process.env.NODE_PATH = join(REPO, "node_modules");
require("node:module").Module._initPaths();

writeFileSync(CFG, JSON.stringify({
  projects: [{
    root, workspace: "wks_probe", enabled: true, lazyMode: false,
    provider: "pi/test", thinking: "high", intervalMinutes: 20,
  }],
  audit: [], auditEvictions: {},
}));

execFileSync(join(REPO, "node_modules", ".bin", "esbuild"), [
  "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
  `--outfile=${BUNDLE}`, "--external:@getpaseo/*",
], { cwd: REPO, stdio: "ignore" });
const server = require(BUNDLE);
const cfg = () => JSON.parse(readFileSync(CFG, "utf8")).projects[0];
const gates = () => cfg().pendingGates ?? [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  for (let i = 0; i < 160; i += 1) {
    if (predicate()) return true;
    await delay(25);
  }
  check(label, false, "timed out");
  return false;
}

function report(task, commit, attempt) {
  return [
    "status=DONE",
    `commit_sha=${commit}`,
    `artifact_path=checks/out/${task}.json`,
    "error=-",
    `task_id: ${task}`,
    `attempt_id: ${attempt}`,
  ].join("\n");
}

function finish(agentId, title, cwd, task, commit, attempt, turnId) {
  server.onTurnEnded({
    agent: { id: agentId, title, cwd },
    turnId,
    outcome: { kind: "completed" },
    timeline: [{ type: "assistant_message", text: report(task, commit, attempt) }],
  }, { paseo: { agents: { ref: () => ({ send: async () => {} }) } } });
}

async function main() {
  // 1. DONE + R0 + idle worker => tick runs the real Guard script.
  finish(PASS_AGENT, "worker T-R0-PASS", passWt, "T-R0-PASS", passCommit, "pass-1", "turn-pass");
  if (!await waitFor(() => gates().some((row) => row.task === "T-R0-PASS"), "DONE report captures an R0 gate")) return;
  check("R0 capture records the full commit", gates().find((row) => row.task === "T-R0-PASS").commit === passCommit);
  check("capture alone does not run the gate", !existsSync(join(passWt, "checks/out", `guard-T-R0-PASS-${passCommit}.json`)));

  await server.wheelPass("interval");
  const passRow = gates().find((row) => row.task === "T-R0-PASS");
  check("the existing tick runs the R0 gate with lazy mode OFF", passRow.status === "passed",
    `status=${passRow.status} detail=${passRow.detail}`);
  const passArtifact = join(passWt, "checks/out", `guard-T-R0-PASS-${passCommit}.json`);
  const passJson = existsSync(passArtifact) ? JSON.parse(readFileSync(passArtifact, "utf8")) : {};
  check("PASS writes the Guard artifact at the contract path",
    passRow.artifactPath === `checks/out/guard-T-R0-PASS-${passCommit}.json`, passRow.artifactPath);
  check("PASS artifact carries a clean committed-tree verdict",
    passJson.verdict === "PASS" && passJson.provenance?.clean === true && passJson.commit === passCommit,
    `verdict=${passJson.verdict}`);

  // 2. Out-of-scope commit => FAIL is recorded, never retried.
  finish(FAIL_AGENT, "worker T-R0-FAIL", failWt, "T-R0-FAIL", failCommit, "fail-1", "turn-fail");
  if (!await waitFor(() => gates().some((row) => row.task === "T-R0-FAIL"), "DONE report captures the failing R0 gate")) return;
  await server.wheelPass("interval");
  const failRow = gates().find((row) => row.task === "T-R0-FAIL");
  const failArtifact = join(failWt, "checks/out", `guard-T-R0-FAIL-${failCommit}.json`);
  const failJson = existsSync(failArtifact) ? JSON.parse(readFileSync(failArtifact, "utf8")) : {};
  check("an out-of-scope commit is recorded FAIL", failRow.status === "failed", `status=${failRow.status}`);
  check("FAIL artifact names the scope violation",
    failJson.verdict === "FAIL" && (failJson.scope?.violations ?? []).some((line) => /outside write_scope/.test(line)),
    (failJson.scope?.violations ?? []).join("; "));
  const failedAt = failJson.generated_at;
  await server.wheelPass("interval");
  const afterRetry = existsSync(failArtifact) ? JSON.parse(readFileSync(failArtifact, "utf8")) : {};
  check("a failed commit is not retried by the next tick", afterRetry.generated_at === failedAt);
  const failAcceptance = server.acceptanceState(root, rootHead).find((row) => row.task === "T-R0-FAIL");
  check("a failed gate does not accept the task",
    failAcceptance !== undefined && failAcceptance.allCommandsPassed === false
      && failAcceptance.status !== "certified", failAcceptance?.status);

  // 3. R1 is not automatic.
  finish(R1_AGENT, "worker T-R1-HUMAN", r1Wt, "T-R1-HUMAN", r1Commit, "r1-1", "turn-r1");
  await delay(600);
  check("an R1 task is not captured for the R0 gate", !gates().some((row) => row.task === "T-R1-HUMAN"));
  await server.wheelPass("interval");
  check("an R1 task gets no automatic Guard artifact",
    !existsSync(join(r1Wt, "checks/out", `guard-T-R1-HUMAN-${r1Commit}.json`)));
  const r1Acceptance = server.acceptanceState(root, rootHead).find((row) => row.task === "T-R1-HUMAN");
  check("an R1 task is not accepted automatically",
    r1Acceptance !== undefined && r1Acceptance.allCommandsPassed === false, r1Acceptance?.status);

  // 4. Metrics: three persisted rows, two shaped like current entries and one legacy (no request time).
  const file = JSON.parse(readFileSync(CFG, "utf8"));
  const auditRow = (id, requestedAt, at) => ({
    attemptId: `metric-${id}`, at, ...(requestedAt ? { requestedAt } : {}),
    project: root, agentId: "dddd4444-0000-4000-8000-000000000004",
    agentTitle: "worker T-METRIC", requestId: `req-${id}`, request: "Bash",
    kind: "shell", decision: "allow", source: "event", delivery: "confirmed",
    recorded: true, ok: true, error: null, task: "T-METRIC",
  });
  file.audit = [
    auditRow(1, "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:05.000Z"),
    auditRow(2, "2026-10-20T00:00:10.000Z", "2026-10-20T00:00:12.500Z"),
    auditRow(3, null, "2026-10-20T00:00:20.500Z"),
  ];
  file.projects[0].pendingGates = file.projects[0].pendingGates;
  const metricManifest = JSON.parse(readFileSync(join(root, "checks/tasks/T-METRIC.json"), "utf8"));
  metricManifest.acceptedAt = "2026-10-20T00:00:40.000Z";
  writeFileSync(join(root, "checks/tasks/T-METRIC.json"), JSON.stringify(metricManifest));
  writeFileSync(CFG, JSON.stringify(file));

  const state = await server.readSteward({ project: root });
  const metric = state.acceptance.find((row) => row.task === "T-METRIC");
  check("permissionWaitMs sums request-to-decision intervals",
    metric?.permissionWaitMs === 7_500, String(metric?.permissionWaitMs));
  check("cycleMs is first audit entry to acceptance",
    metric?.cycleMs === 35_000, String(metric?.cycleMs));

  if (failures > 0) {
    console.error(`\n${failures} failure(s)`);
    process.exitCode = 1;
  } else {
    console.log("PASS leg40: R0 DONE reaches the existing tick, PASS/FAIL recorded, R1 untouched, wait/cycle from audit");
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
