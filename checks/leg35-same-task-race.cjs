#!/usr/bin/env node
/**
 * LEG 35 — two dispatches of the SAME task must not both win.
 *
 * `tools/dispatch.sh` used to scan for a live worktree, then scan for a running agent, then launch.
 * Both scan and launch are separated by time, so two dispatchers could both pass. `tools/reserve.sh`
 * holds an flock over the whole check-and-write. This check races eight reservations for one task id
 * against a throwaway repo root and requires exactly one WON.
 */
const { execFile, spawnSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const REPO = path.resolve(__dirname, "..");
const RESERVE = path.join(REPO, "tools", "reserve.sh");
const TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg35-"));
const TASK = "T-RACE";
const JSON_PATH = path.join(TMP, ".locks", `${TASK}.json`);
let failures = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} — ${error.message}`);
  }
}

function reserve(args, paseoBin = "/bin/false") {
  return new Promise((resolve) => {
    execFile("bash", [RESERVE, ...args], {
      env: { ...process.env, RESERVE_REPO: TMP, PASEO_BIN: paseoBin },
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout: String(stdout).trim(), stderr: String(stderr).trim() });
    });
  });
}

async function main() {
  const runs = await Promise.all(Array.from({ length: 8 }, () => reserve([TASK])));
  const won = runs.filter((r) => r.code === 0 && /^WON /.test(r.stdout));
  const lost = runs.filter((r) => r.code === 3 && /^LOST /.test(r.stdout));

  check("exactly one of eight concurrent reservations wins", () => {
    assert.equal(won.length, 1, `WON=${won.length} (${runs.map((r) => `${r.code}:${r.stdout}`).join(" | ")})`);
  });
  check("the other seven are LOST with exit 3", () => {
    assert.equal(lost.length, 7, `LOST=${lost.length} (${runs.map((r) => `${r.code}:${r.stdout}`).join(" | ")})`);
  });
  check("the winner leaves one reservation json", () => {
    assert.ok(existsSync(JSON_PATH), `${JSON_PATH} is missing`);
    const saved = JSON.parse(readFileSync(JSON_PATH, "utf8"));
    assert.equal(saved.task, TASK);
    assert.equal(saved.token, won[0].stdout.replace(/^WON /, ""));
    assert.ok(saved.pid && saved.at, "pid and at are recorded");
  });

  const winnerToken = won[0].stdout.replace(/^WON /, "");
  const loserRelease = await reserve(["--release", TASK, "a-loser-token"]);
  check("a loser's token cannot free the winner's reservation", () => {
    assert.equal(loserRelease.code, 3, `exit=${loserRelease.code}`);
    assert.match(loserRelease.stdout, /^LOST /);
    assert.ok(existsSync(JSON_PATH), "the winner's json must survive");
  });

  const winnerRelease = await reserve(["--release", TASK, winnerToken]);
  check("the winner's own token releases the reservation", () => {
    assert.equal(winnerRelease.code, 0, `exit=${winnerRelease.code} ${winnerRelease.stdout}`);
    assert.ok(!existsSync(JSON_PATH), "the json is gone after release");
  });

  // V12-07: a write that does not land is never a win.
  const locks = path.join(TMP, ".locks");
  const W = "T-WRITE";
  const wJson = path.join(locks, `${W}.json`);
  // The review's fixture: an expired reservation the caller cannot write. Publishing by rename replaces it, and the
  // json on disk then holds the winner's token.
  writeFileSync(wJson, JSON.stringify({ task: W, token: "expired", pid: "1", at: "2026-01-01T00:00:00Z" }) + "\n");
  chmodSync(wJson, 0o444);
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
  utimesSync(wJson, old, old);
  const replaced = await reserve([W]);
  check("an expired read-only reservation is replaced, and WON matches the json on disk", () => {
    assert.equal(replaced.code, 0, `exit=${replaced.code} ${replaced.stdout}`);
    assert.equal(JSON.parse(readFileSync(wJson, "utf8")).token, replaced.stdout.replace(/^WON /, ""));
  });
  // A directory that refuses the write (or a full disk): both sequential attempts must lose, not both win.
  const F = "T-FULL";
  writeFileSync(path.join(locks, `${F}.lock`), "");
  chmodSync(locks, 0o555);
  const first = await reserve([F]);
  const second = await reserve([F]);
  check("a reservation that cannot be written prints LOST write-failed and exits non-zero", () => {
    for (const run of [first, second]) {
      assert.notEqual(run.code, 0, `exit=${run.code} ${run.stdout}`);
      assert.equal(run.stdout, "LOST write-failed");
    }
    assert.ok(!existsSync(path.join(locks, `${F}.json`)), "no reservation is left behind");
  });
  const stuck = await reserve(["--release", W, replaced.stdout.replace(/^WON /, "")]);
  check("a release that cannot delete the json is not RELEASED", () => {
    assert.equal(stuck.code, 3, `exit=${stuck.code} ${stuck.stdout}`);
    assert.equal(stuck.stdout, "LOST release-failed");
    assert.ok(existsSync(wJson), "the json is still there, and the caller was told");
  });
  chmodSync(locks, 0o755);

  // V12-08: the live-resource scan matches the task key exactly. T-18 is not held by T-181's worktree or agent.
  const workspaces = path.join(TMP, "workspaces.json");
  const agents = path.join(TMP, "agents.json");
  const fake = path.join(TMP, "paseo");
  writeFileSync(fake, `#!/bin/sh
case "$1" in
  workspace) cat ${JSON.stringify(workspaces)} ;;
  agent) cat ${JSON.stringify(agents)} ;;
esac
`, { mode: 0o755 });
  const scenario = async (task, ws, ag) => {
    writeFileSync(workspaces, JSON.stringify(ws));
    writeFileSync(agents, JSON.stringify(ag));
    const run = await reserve([task], fake);
    const json = path.join(locks, `${task}.json`);
    if (existsSync(json)) rmSync(json);
    return run;
  };
  const t181 = [{ workspaceId: "wks_181", name: "paseo/T-181", isolation: "worktree", cwd: "/w/x/paseo-t-181" }];
  const t181Agent = [{ id: "a181", name: "T-181 worker", status: "running", cwd: "/w/x/paseo-t-181" }];
  const unrelated = await scenario("T-18", t181, t181Agent);
  check("an unrelated T-181 worktree and agent do not hold T-18", () => {
    assert.equal(unrelated.code, 0, `exit=${unrelated.code} ${unrelated.stdout}`);
    assert.match(unrelated.stdout, /^WON /);
  });
  const ownWorktree = await scenario("T-18", [...t181, { workspaceId: "wks_18", name: "other", isolation: "worktree", cwd: "/w/x/paseo-t-18" }], []);
  check("T-18's own worktree holds T-18", () => {
    assert.equal(ownWorktree.code, 3, `exit=${ownWorktree.code} ${ownWorktree.stdout}`);
    assert.match(ownWorktree.stdout, /live worktree/);
  });
  const ownAgent = await scenario("T-18", [], [...t181Agent, { id: "a18", name: "T-18: repair", status: "running", cwd: "/elsewhere" }]);
  check("an agent titled with exactly T-18 holds T-18", () => {
    assert.equal(ownAgent.code, 3, `exit=${ownAgent.code} ${ownAgent.stdout}`);
    assert.match(ownAgent.stdout, /running agent/);
  });
  const suffixed = await scenario("T-18", [{ workspaceId: "wks_x", name: "paseo/T-18-old", isolation: "worktree", cwd: "/w/x/paseo-t-18-old" }], [{ id: "ax", name: "T-18-old worker", status: "running", cwd: "/w/x/paseo-t-18-old" }]);
  check("T-18-old is a different key", () => {
    assert.equal(suffixed.code, 0, `exit=${suffixed.code} ${suffixed.stdout}`);
  });
}

// --- V12-09 / V12-10: the peer channel's attempt and turn races, on the same task -------------------------------
const PEER = path.join(REPO, "tools", "peer-send.sh");
const PEER_TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg35-peer-"));

function peerFixture({ agents, workspaces = [], recorded, flipToRunning = false }) {
  const dir = mkdtempSync(path.join(PEER_TMP, "case-"));
  mkdirSync(path.join(dir, "checks", "tasks"), { recursive: true });
  mkdirSync(path.join(dir, ".locks"), { recursive: true });
  writeFileSync(path.join(dir, "checks", "tasks", "T-18.json"), JSON.stringify({ task_id: "T-18" }));
  if (recorded) writeFileSync(path.join(dir, ".locks", "T-18.json"), JSON.stringify({ task: "T-18", token: "t", agent: recorded }));
  const agentsFile = path.join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify(agents));
  writeFileSync(path.join(dir, "workspaces.json"), JSON.stringify(workspaces));
  // flipToRunning: the first `agent ls` sees the target idle, every later one sees it running -- a turn that starts
  // between the resolution and the delivery.
  writeFileSync(path.join(dir, "paseo"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(dir, "calls.jsonl"))}, JSON.stringify(args) + "\\n");
if (args[0] === "agent" && args[1] === "ls") {
  const counter = ${JSON.stringify(path.join(dir, "ls-count"))};
  const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, "utf8")) : 0;
  fs.writeFileSync(counter, String(n + 1));
  const rows = JSON.parse(fs.readFileSync(${JSON.stringify(agentsFile)}, "utf8"));
  if (${flipToRunning} && n > 0) for (const row of rows) row.status = "running";
  process.stdout.write(JSON.stringify(rows));
} else if (args[0] === "workspace" && args[1] === "ls") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(dir, "workspaces.json"))}, "utf8"));
}
`, { mode: 0o755 });
  const result = spawnSync("bash", [PEER, "T-17", "T-18", "--type", "ASK", "--ref", "a.ts:1@abc", "--need", "Is the field optional?"], {
    encoding: "utf8", env: { ...process.env, PASEO_BIN: path.join(dir, "paseo"), PEER_REPO: dir },
  });
  const calls = existsSync(path.join(dir, "calls.jsonl"))
    ? readFileSync(path.join(dir, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];
  const inboxPath = path.join(dir, "checks", "out", "peer-inbox-T-18.jsonl");
  const inbox = existsSync(inboxPath) ? readFileSync(inboxPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { ...result, sends: calls.filter((a) => a[0] === "send"), inbox };
}

function peerChecks() {
  // The review's fixture: a retired attempt listed before its replacement, same title, same directory.
  const old = { id: "old", name: "T-18 worker", cwd: "/w/paseo-t-18", status: "idle" };
  const replacement = { id: "new", name: "T-18 worker", cwd: "/w/paseo-t-18", status: "running" };
  const ambiguous = peerFixture({ agents: [old, replacement] });
  check("V12-09: two live attempts and no recorded one are refused, not resolved by list order", () => {
    assert.equal(ambiguous.status, 4, `exit=${ambiguous.status} ${ambiguous.stderr}`);
    assert.match(ambiguous.stderr, /several live attempts/);
    assert.equal(ambiguous.sends.length, 0);
  });
  const recordedNew = peerFixture({ agents: [old, replacement], recorded: "new" });
  check("V12-09: the dispatcher's record picks the current attempt", () => {
    assert.equal(recordedNew.status, 0, `exit=${recordedNew.status} ${recordedNew.stderr}`);
    assert.equal(recordedNew.inbox.length, 1, "the running replacement gets a queued message");
    assert.equal(recordedNew.inbox[0].agent_id, "new");
    assert.equal(recordedNew.sends.length, 0);
  });
  const stale = peerFixture({
    agents: [{ ...old, created: "3 hours ago" }, { ...replacement, status: "idle", created: "just now" }],
    recorded: "old",
  });
  check("V12-09: when the newest attempt is not the recorded one, nothing is sent", () => {
    assert.equal(stale.status, 4, `exit=${stale.status} ${stale.stderr}`);
    assert.match(stale.stderr, /dispatcher recorded old/);
    assert.equal(stale.sends.length, 0);
  });
  const newest = peerFixture({ agents: [{ ...old, created: "3 hours ago" }, { ...replacement, status: "idle", created: "just now" }] });
  check("V12-09: without a record, the newest live attempt is the target", () => {
    assert.equal(newest.status, 0, `exit=${newest.status} ${newest.stderr}`);
    assert.equal(newest.sends.length, 1);
    assert.equal(newest.sends[0][1], "new");
  });
  const suffixed = peerFixture({
    agents: [{ id: "x", name: "T-18-old worker", cwd: "/w/paseo-t-18-old", status: "idle" }],
    workspaces: [{ workspaceId: "wks_x", name: "paseo/T-18-old", isolation: "worktree", cwd: "/w/paseo-t-18-old" }],
  });
  check("V12-09: T-18-old is not T-18", () => {
    assert.equal(suffixed.status, 4, `exit=${suffixed.status} ${suffixed.stderr}`);
    assert.equal(suffixed.sends.length, 0);
  });

  // V12-10: idle when resolved, running by the time of delivery -> queued, never steered.
  const flipped = peerFixture({ agents: [{ id: "a18", name: "T-18 worker", cwd: "/w/paseo-t-18", status: "idle" }], flipToRunning: true });
  check("V12-10: a target that became running before delivery is queued, not steered", () => {
    assert.equal(flipped.status, 0, `exit=${flipped.status} ${flipped.stderr}`);
    assert.equal(flipped.stdout.trim(), "QUEUED");
    assert.equal(flipped.sends.length, 0, `send calls=${JSON.stringify(flipped.sends)}`);
    assert.equal(flipped.inbox.length, 1);
    assert.equal(flipped.inbox[0].agent_id, "a18");
  });
  const steady = peerFixture({ agents: [{ id: "a18", name: "T-18 worker", cwd: "/w/paseo-t-18", status: "idle" }] });
  check("V12-10: a target still idle at delivery is sent to directly", () => {
    assert.equal(steady.status, 0, `exit=${steady.status} ${steady.stderr}`);
    assert.equal(steady.stdout.trim(), "SENT");
    assert.equal(steady.sends.length, 1);
  });
}

main()
  .then(peerChecks)
  .catch((error) => {
    console.error("check crashed:", error);
    failures += 1;
  })
  .finally(() => {
    rmSync(TMP, { recursive: true, force: true });
    rmSync(PEER_TMP, { recursive: true, force: true });
    console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });
