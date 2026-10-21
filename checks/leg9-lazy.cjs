#!/usr/bin/env node
/**
 * LEG 9 acceptance — 懒人模式.
 *
 * The owner's rule, and the whole point of the switch:
 *
 *   1. OFF means nothing automatic. A released lease does not start anyone; only the owner's button does.
 *   2. ON means unattended: a released lease hands over, and a stale one is recovered.
 *   3. A RUNNING steward session outranks every timer. Its heartbeat may be quiet mid-thought; that is not
 *      an absence, and starting a second steward would double the spend.
 *   4. The dispatch floor survives a reload, because it is on disk (independent review F1: the in-memory
 *      map was empty after every plugin load, so a released block could storm a new agent per beat).
 *   5. A finished worker wakes the SAME steward session. No new agent, no polling.
 *
 * Throwaway roots, throwaway config, a fake `paseo` binary. Nothing real is touched.
 */
const { execFileSync } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const BUNDLE = "/tmp/steward-leg9-check.cjs";
const TMP = join(os.tmpdir(), `leg9-${process.pid}`);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function iso(minutesOffset) {
  return new Date(Date.now() + minutesOffset * 60_000).toISOString().slice(0, 16) + "Z";
}

function leaseBlock({ state, heartbeat, agent = "aaaa1111-0000-4000-8000-000000000001" }) {
  return [
    "# COMMAND", "",
    "## Lease", "",
    "    session=pi:test",
    `    paseo-agent=${agent}`,
    "    since=2026-10-19T00:00Z",
    `    heartbeat=${heartbeat ?? iso(0)}`,
    `    state=${state}`,
    "", "## Dispatch ledger", "",
  ].join("\n");
}

function project(name, lease) {
  const root = join(TMP, name);
  mkdirSync(join(root, "control"), { recursive: true });
  writeFileSync(join(root, "control", "COMMAND.md"), lease);
  return root;
}

function row(root, patch = {}) {
  return {
    root, workspace: "wks_test", provider: "pi/test", thinking: "high",
    intervalMinutes: 20, nextTickAt: null, lastDispatchAt: null, lazyMode: true, enabled: true,
    leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true, ...patch,
  };
}

async function main() {
  execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + BUNDLE, "--external:@getpaseo/*",
  ], { cwd: REPO, stdio: "ignore" });

  mkdirSync(TMP, { recursive: true });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const fake = join(TMP, "fake-paseo");
  const spawnLog = join(TMP, "spawn.log");
  const agentsFile = join(TMP, "agents.json");
  const workspacesFile = join(TMP, "workspaces.json");
  writeFileSync(workspacesFile, "[]");
  writeFileSync(agentsFile, "[]");
  // Branch on the subcommand: `agent ls` and `workspace ls` answer from files, `run` records one line.
  writeFileSync(fake, `#!/bin/sh
case "$1 $2" in
  "agent ls") cat ${agentsFile};;
  "workspace ls") cat ${workspacesFile};;
  *) printf 'SPAWN %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> ${spawnLog}; printf '{"id":"agent_test"}\\n';;
esac
`);
  chmodSync(fake, 0o755);

  const cfgPath = join(TMP, "config.json");
  process.env.PASEO_STEWARD_CONFIG = cfgPath;
  process.env.PASEO_BIN = fake;

  const writeCfg = (...rows) => writeFileSync(cfgPath, JSON.stringify({ projects: rows, audit: [], auditEvictions: {} }, null, 2));
  const readCfg = () => JSON.parse(readFileSync(cfgPath, "utf8"));
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean) : []);

  const m = require(BUNDLE);

  // 1. 懒人模式 OFF: a released lease starts nobody. Nothing automatic happens by default.
  const rOff = project("off", leaseBlock({ state: "released" }));
  writeCfg(row(rOff, { lazyMode: false }));
  await m.wheelPass("interval");
  check("lazy mode OFF dispatches nothing, even with a released lease", spawns().length === 0,
    `${spawns().length} spawn(s)`);

  // 2. ON + released: hands over.
  const rOn = project("on", leaseBlock({ state: "released" }));
  writeCfg(row(rOn));
  await m.wheelPass("interval");
  check("lazy mode ON hands a released lease over", spawns().length === 1, `${spawns().length} spawn(s)`);

  // 3. A RUNNING steward session outranks a stale heartbeat: the session is driving, so nobody else starts.
  const rLive = project("live-session", leaseBlock({ state: "held", heartbeat: iso(-30) }));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "live-session", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rLive },
  ]));
  writeFileSync(agentsFile, JSON.stringify([
    { id: "aaaa1111-0000-4000-8000-000000000001", name: "the steward", provider: "pi", cwd: rLive, status: "running" },
  ]));
  writeCfg(row(rLive));
  const beforeLive = spawns().length;
  // A fresh module, because the agent list is cached for a minute in the running plugin.
  delete require.cache[require.resolve(BUNDLE)];
  const mLive = require(BUNDLE);
  await mLive.wheelPass("interval");
  check("a claimed lease with a live agent blocks a second steward, however stale its heartbeat is",
    spawns().length === beforeLive, `${spawns().length - beforeLive} spawn(s)`);

  // F10: the same listed ID is present while running, absent when it cannot work.
  for (const status of ["running", "error", "idle"]) {
    writeCfg(row(rLive));
    writeFileSync(agentsFile, JSON.stringify([
      { id: "aaaa1111-0000-4000-8000-000000000001", cwd: rLive, status },
    ]));
    delete require.cache[require.resolve(BUNDLE)];
    const probe = require(BUNDLE);
    const before = spawns().length;
    await probe.wheelPass("interval");
    check(`claimed agent in ${status} ${status !== "running" ? "allows" : "blocks"} successor`,
      spawns().length - before === (status !== "running" ? 1 : 0));
    const state = await probe.readSteward({ project: rLive });
    check(`read state agrees for ${status}`, state.lease.agentPresent === (status === "running"));
  }
  // An unreadable list remains unknown, even after the error case.
  writeCfg(row(rLive));
  writeFileSync(agentsFile, "unreadable");
  delete require.cache[require.resolve(BUNDLE)];
  const unknownProbe = require(BUNDLE);
  const beforeUnknown = spawns().length;
  await unknownProbe.wheelPass("interval");
  check("unreadable agent list blocks successor", spawns().length === beforeUnknown);
  writeCfg(row(rLive));
  const beforeGone = spawns().length;

  // 4. Same lease, the session is gone: that IS an absence, so recovery dispatches.
  writeFileSync(agentsFile, "[]");
  // The liveness answer is cached for a minute; drop the cache the same way a reload would.
  delete require.cache[require.resolve(BUNDLE)];
  const m2 = require(BUNDLE);
  await m2.wheelPass("interval");
  check("the same stale lease 接管s once the claimed agent is gone from Paseo", spawns().length === beforeGone + 1,
    `${spawns().length - beforeLive} spawn(s)`);

  // 5. The floor is on disk: a fresh module (a reload) still refuses a dispatch inside the window.
  const rFloor = project("floor", leaseBlock({ state: "released" }));
  writeCfg(row(rFloor, { lastDispatchAt: iso(0) }));
  const beforeFloor = spawns().length;
  delete require.cache[require.resolve(BUNDLE)];
  const m3 = require(BUNDLE);
  await m3.wheelPass("interval");
  check("the 2-minute floor survives a fresh module (it is persisted, not in memory)",
    spawns().length === beforeFloor, `${spawns().length - beforeFloor} spawn(s)`);

  // 6. A finished worker wakes the SAME steward session — one message, not a new agent.
  const rWake = project("wake", leaseBlock({ state: "held", agent: "bbbb2222-0000-4000-8000-000000000002" }));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "wake", workspaceId: "wks_wake", name: "main", isolation: "local", cwd: rWake },
  ]));
  writeFileSync(agentsFile, "[]");
  writeCfg(row(rWake));
  const wakes = [];
  m3.onTurnEnded({
    agent: { id: "cccc3333-0000-4000-8000-000000000003", workspaceId: "wks_wake", parentAgentId: null, provider: "pi", cwd: rWake, title: "LEG 99 worker" },
    turnId: "t1",
    outcome: { kind: "completed" },
    timeline: [],
  }, { paseo: { agents: { ref: (id) => ({ send: async (text, options) => { wakes.push({ id, text, options }); } }) } }, signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 2_000));
  check("a finished worker wakes the steward session in place", wakes.length === 1 && wakes[0].id === "bbbb2222-0000-4000-8000-000000000002",
    `${wakes.length} wake(s)`);
  check("the wake steers rather than interrupting, and names the worker",
    wakes[0]?.options?.activeTurnBehavior === "steer" && /cccc333/.test(wakes[0]?.text ?? ""),
    (wakes[0]?.text ?? "").split("\n")[0]);

  // 7. The steward's own turn must not wake the steward: that is self-oscillation.
  const beforeSelf = wakes.length;
  m3.onTurnEnded({
    agent: { id: "bbbb2222-0000-4000-8000-000000000002", workspaceId: "wks_wake", parentAgentId: null, provider: "pi", cwd: rWake, title: "something" },
    turnId: "t2",
    outcome: { kind: "completed" },
    timeline: [],
  }, { paseo: { agents: { ref: (id) => ({ send: async (text, options) => { wakes.push({ id, text, options }); } }) } }, signal: new AbortController().signal });
  await new Promise((r) => setTimeout(r, 2_000));
  check("the steward's own turn does not wake itself", wakes.length === beforeSelf, `${wakes.length - beforeSelf} wake(s)`);


  // 9. A project can be disabled while lazy mode is still on: the fields drift in real configs. A disabled
  // project must be neither dispatched nor woken — the owner saw a stopped project keep running (2026-10-20).
  const rDisabled = project("disabled-drift", leaseBlock({ state: "held", agent: "cccc3333-0000-4000-8000-000000000003" }));
  writeFileSync(agentsFile, JSON.stringify([
    { id: "cccc3333-0000-4000-8000-000000000003", name: "the steward", provider: "pi", cwd: rDisabled, status: "running" },
    { id: "dddd4444-0000-4000-8000-000000000004", name: "a worker", provider: "pi", cwd: rDisabled, status: "running" },
  ]));
  writeCfg(row(rDisabled, { enabled: false, lazyMode: true }));
  const beforeDisabled = spawns().length;
  const beforeDisabledWakes = wakes.length;
  delete require.cache[require.resolve(BUNDLE)];
  const mDisabled = require(BUNDLE);
  await mDisabled.wheelPass("interval");
  await mDisabled.onTurnEnded(
    { agent: { id: "dddd4444-0000-4000-8000-000000000004", title: "a worker", cwd: rDisabled }, outcome: { kind: "completed" } },
    { paseo: { agents: { ref: () => ({ send: async () => { wakes.push({ id: "forbidden" }); } }) } }, signal: new AbortController().signal },
  );
  await new Promise((r) => setTimeout(r, 2_000));
  check("a disabled project is neither dispatched nor woken, even with lazy mode on",
    spawns().length === beforeDisabled && wakes.length === beforeDisabledWakes,
    `${spawns().length - beforeDisabled} spawn(s), ${wakes.length - beforeDisabledWakes} wake(s)`);

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`} — ${spawns().length} dispatch(es), ${wakes.length} wake(s)`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check crashed:", error);
  process.exit(2);
});
