#!/usr/bin/env node
/**
 * LEG 10 acceptance — 接管 and the capitalist rule.
 *
 * The owner's two rulings, which replace the earlier design:
 *
 *   1. **A claimed lease IS a steward.** Existence is the claim plus a matching agent in Paseo. The heartbeat
 *      is recency, never existence, so an old heartbeat must never read as "lost" and must never start a
 *      duplicate. Automatic hand-over is a pseudo-need.
 *   2. **接管 only.** A steward is started only when the project has none: no claim, or a claim naming an
 *      agent Paseo no longer has. When one exists, the wheel pokes it — never replaces it.
 *   3. **The capitalist rule.** With 懒人模式 on, every five minutes the plugin checks the worktree slots:
 *      free slots plus a non-empty Ready queue means the steward is wasting money, so it gets one poke. It
 *      never starts an agent for this.
 *
 * Throwaway roots, throwaway config, a fake `paseo` binary. Nothing real is touched.
 */
const { execFileSync, spawn } = require("node:child_process");
const { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const BUNDLE = process.env.BUNDLE ?? "/tmp/steward-leg10-check.cjs";
const TMP = join(os.tmpdir(), `leg10-${process.pid}`);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function iso(minutesOffset) {
  return new Date(Date.now() + minutesOffset * 60_000).toISOString().slice(0, 16) + "Z";
}

const STEWARD = "aaaa1111-0000-4000-8000-000000000001";

function leaseBlock({ state = "held", heartbeat, agent = STEWARD }) {
  return [
    "# COMMAND", "",
    "## Lease", "",
    "    session=pi:test",
    `    paseo-agent=${agent}`,
    "    since=2026-10-19T00:00Z",
    `    heartbeat=${heartbeat ?? iso(0)}`,
    `    state=${state}`,
    "", "## Ready queue", "",
    "| leg | goal |", "|---|---|",
    "| **99** | something worth doing |",
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
    intervalMinutes: 20, nextTickAt: null, lastDispatchAt: null, lastPokeAt: null, lastPokeFingerprint: null,
    pokeFailureCount: 0, pokeFailureAgent: null,
    lazyMode: true, enabled: true,
    juniorProvider: "pi/cheap-junior", leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true, ...patch,
  };
}

async function main() {
  if (!process.env.BUNDLE) execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + BUNDLE, "--external:@getpaseo/*",
  ], { cwd: REPO, stdio: "ignore" });

  mkdirSync(TMP, { recursive: true });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const fake = join(TMP, "fake-paseo");
  const spawnLog = join(TMP, "spawn.log");
  const pokeLog = join(TMP, "poke.log");
  const agentsFile = join(TMP, "agents.json");
  const workspacesFile = join(TMP, "workspaces.json");
  const listErrorFile = join(TMP, "list-error");
  const sendErrorFile = join(TMP, "send-error");
  writeFileSync(agentsFile, "[]");
  writeFileSync(workspacesFile, "[]");
  writeFileSync(fake, `#!/bin/sh
case "$1 $2" in
  "agent ls") if [ -f "${listErrorFile}" ]; then printf 'agent list unavailable\\n' >&2; exit 1; fi; cat ${agentsFile};;
  "agent send") if [ -f "${sendErrorFile}" ]; then printf 'session/provider unavailable\\n' >&2; exit 1; fi; printf 'POKE %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> ${pokeLog};;
  "workspace ls") cat ${workspacesFile};;
  *) printf 'SPAWN %s\\n' "$(printf '%s ' "$@" | tr '\\n' ' ')" >> ${spawnLog}; printf '{"id":"agent_test"}\\n';;
esac
`);
  chmodSync(fake, 0o755);

  const cfgPath = join(TMP, "config.json");
  process.env.PASEO_STEWARD_CONFIG = cfgPath;
  process.env.PASEO_BIN = fake;

  const writeCfg = (...rows) => writeFileSync(cfgPath, JSON.stringify({ projects: rows, audit: [], auditEvictions: {} }, null, 2));
  const patchCfg = (patch) => {
    const c = JSON.parse(readFileSync(cfgPath, "utf8"));
    Object.assign(c.projects[0], patch);
    writeFileSync(cfgPath, JSON.stringify(c, null, 2));
  };
  const spawns = () => (existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean) : []);
  const pokes = () => (existsSync(pokeLog) ? readFileSync(pokeLog, "utf8").trim().split("\n").filter(Boolean) : []);
  const fresh = () => { delete require.cache[require.resolve(BUNDLE)]; return require(BUNDLE); };

  let m = fresh();

  // 1. 懒人模式 OFF: nothing automatic, whatever the lease says.
  const rOff = project("off", leaseBlock({ state: "released", agent: "(none — no steward)" }));
  writeCfg(row(rOff, { lazyMode: false }));
  await m.wheelPass("interval");
  check("lazy mode OFF starts nobody", spawns().length === 0, `${spawns().length} spawn(s)`);

  // 2. A CLAIMED lease is a steward, however old the heartbeat. This is the rule that was violated.
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: "/tmp", status: "running" }]));
  const rOld = project("old-heartbeat", leaseBlock({ state: "held", heartbeat: iso(-90) }));
  writeCfg(row(rOld));
  await m.wheelPass("interval");
  check("a 90-minute-old heartbeat is still a steward, because the lease claims one", spawns().length === 0,
    `${spawns().length} spawn(s)`);

  // 3. Claimed + a released block: still no successor. Hand-over is not a thing any more.
  const rRel = project("released-claimed", leaseBlock({ state: "released" }));
  writeCfg(row(rRel));
  await m.wheelPass("interval");
  check("a released block does not start a successor while an agent is claimed", spawns().length === 0,
    `${spawns().length} spawn(s)`);

  // 4. 接管: no claim at all.
  writeFileSync(agentsFile, "[]");
  const rNone = project("no-claim", leaseBlock({ agent: "(none — no steward)" }));
  writeCfg(row(rNone));
  m = fresh();
  await m.wheelPass("interval");
  check("no claim at all starts one steward", spawns().length === 1, `${spawns().length} spawn(s)`);
  check("接管 dispatches into the project's main workspace",
    spawns()[0]?.includes("--workspace wks_test") === true, spawns()[0]?.slice(0, 80) ?? "no spawn");

  // 5. 接管: the claim names an agent Paseo no longer has.
  const rGone = project("gone-agent", leaseBlock({ agent: "dddd4444-0000-4000-8000-000000000004" }));
  writeCfg(row(rGone));
  m = fresh();
  await m.wheelPass("interval");
  check("a claim naming a deleted agent starts one steward", spawns().length === 2, `${spawns().length} spawn(s)`);

  // 5b. A lease that writes the id plus a human label is still a claim: the id is what counts.
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: "/tmp", status: "running" }]));
  const rLabel = project("labelled-claim", leaseBlock({ agent: `${STEWARD} (scheduled steward tick, interval)` }));
  writeCfg(row(rLabel));
  m = fresh();
  const beforeLabel = spawns().length;
  await m.wheelPass("interval");
  check("a claim written as `id (label)` still counts as a steward", spawns().length === beforeLabel,
    `${spawns().length - beforeLabel} spawn(s)`);

  // 6. The floor is on disk: a fresh module still refuses a second start inside the window.
  const rFloor = project("floor", leaseBlock({ agent: "(none — no steward)" }));
  writeCfg(row(rFloor, { lastDispatchAt: iso(0) }));
  m = fresh();
  await m.wheelPass("interval");
  check("the 2-minute floor survives a fresh module", spawns().length === 2, `${spawns().length} spawn(s)`);

  // 7. Capitalist rule: steward alive + free slots + queued work => one poke, no new agent.
  const rCap = project("capitalist", leaseBlock({}));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: rCap, status: "running" }]));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "capitalist", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rCap },
  ]));
  writeCfg(row(rCap));
  m = fresh();
  const beforePokes = pokes().length;
  await m.wheelPass("interval");
  check("capitalist scan pokes the steward instead of starting an agent",
    pokes().length === beforePokes + 1 && spawns().length === 2,
    `${pokes().length - beforePokes} poke(s), ${spawns().length} spawn(s)`);

  // 7b. The poke must name the CHEAP tier: a capitalist does not send seniors to do junior work.
  const pokeText = existsSync(pokeLog) ? readFileSync(pokeLog, "utf8") : "";
  check("the capitalist poke names the cheap tier", /pi\/cheap-junior/.test(pokeText), "juniorProvider in the poke");

  // 7c. A worker already running in the MAIN workspace costs no worktree slot, but it is not free capacity.
  //     Counting worktrees alone poked the steward with three workers already out.
  const rBusy = project("busy", leaseBlock({}));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "busy", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rBusy },
  ]));
  writeFileSync(agentsFile, JSON.stringify([
    { id: STEWARD, name: "s", cwd: rBusy, status: "running" },
    ...Array.from({ length: 5 }, (_, i) => ({ id: `eeee000${i}-0000-4000-8000-00000000000${i}`, name: `worker ${i}`, cwd: rBusy, status: "running" })),
  ]));
  writeCfg(row(rBusy));
  m = fresh();
  const beforeBusy = pokes().length;
  await m.wheelPass("interval");
  check("a project with five workers already out is not poked", pokes().length === beforeBusy,
    `${pokes().length - beforeBusy} poke(s)`);

  // 8. ...but not twice inside five minutes.
  await m.wheelPass("interval");
  check("the capitalist scan has a five-minute cooldown", pokes().length === beforePokes + 1,
    `${pokes().length - beforePokes - 1} extra poke(s)`);

  // 8b. A second poke with the SAME free/queued fingerprint buys nothing: the steward already heard it.
  //     Change the facts (a slot frees up) and it pokes again.
  const beforeRepeat = pokes().length;
  // A FRESH module, because the dedupe must survive a plugin reload. The first version kept it in a Map and
  // the daemon poked every five minutes anyway: in-memory dedupe in a plugin that reloads is not dedupe.
  const m2 = fresh();
  await m2.wheelPass("interval");
  check("an unchanged fingerprint is not poked again, even after a reload", pokes().length === beforeRepeat,
    `${pokes().length - beforeRepeat} extra poke(s)`);

  // 9. No queued work means no poke: the scan must not spend a turn saying "nothing to do".
  const rEmpty = project("no-queue", leaseBlock({}).replace(/## Ready queue[\s\S]*?## Dispatch ledger/, "## Dispatch ledger"));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "no-queue", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rEmpty },
  ]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: rEmpty, status: "running" }]));
  writeCfg(row(rEmpty));
  m = fresh();
  await m.wheelPass("interval");
  check("an empty Ready queue means no poke", pokes().length === beforePokes + 1, `${pokes().length - beforePokes - 1} poke(s)`);

  // 10. A finished worker wakes the SAME steward session; the steward's own turn does not.
  const wakes = [];
  const ctx = { paseo: { agents: { ref: (id) => ({ send: async (text, options) => { wakes.push({ id, text, options }); } }) } }, signal: new AbortController().signal };
  m.onTurnEnded({
    agent: { id: "cccc3333-0000-4000-8000-000000000003", workspaceId: "wks_test", parentAgentId: null, provider: "pi", cwd: rEmpty, title: "worker" },
    turnId: "t1", outcome: { kind: "completed" }, timeline: [],
  }, ctx);
  await new Promise((r) => setTimeout(r, 2_000));
  m.onTurnEnded({
    agent: { id: STEWARD, workspaceId: "wks_test", parentAgentId: null, provider: "pi", cwd: rEmpty, title: "steward" },
    turnId: "t2", outcome: { kind: "completed" }, timeline: [],
  }, ctx);
  await new Promise((r) => setTimeout(r, 2_000));
  check("a worker's finish wakes the same steward session, and only that", wakes.length === 1 && wakes[0].id === STEWARD,
    `${wakes.length} wake(s)`);

  // 11. F2: two real processes both read the old config inside agent ls. The real CLI took 0.23–0.25 s
  // in the review; its faithful fake reproduced 3/5 runs. This barrier makes the overlap deterministic.
  // Delay the second answer until AFTER the first dispatch releases its lock, so a lock without the
  // fresh lastDispatchAt comparison would also fail this case. No project writes by either dispatcher.
  const concurrent = join(TMP, "concurrent");
  mkdirSync(concurrent);
  const rRace = project("race", leaseBlock({ state: "released" }));
  const commandBefore = readFileSync(join(rRace, "control/COMMAND.md"), "utf8");
  const raceConfig = join(concurrent, "config.json");
  const raceLog = join(concurrent, "spawns");
  const firstGate = join(concurrent, "first");
  const secondGate = join(concurrent, "second");
  const raceFake = join(concurrent, "paseo.cjs");
  writeFileSync(raceConfig, JSON.stringify({ projects: [row(rRace)], audit: [], auditEvictions: {} }));
  writeFileSync(raceFake, `#!${process.execPath}
const fs = require('node:fs');
const delay = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  if (process.argv[2] === 'agent' && process.argv[3] === 'ls') {
    let first = false;
    try { fs.closeSync(fs.openSync(${JSON.stringify(firstGate)}, 'wx')); first = true; }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    if (first) {
      const until = Date.now() + 10000;
      while (!fs.existsSync(${JSON.stringify(secondGate)})) {
        if (Date.now() > until) throw Error('second dispatcher never entered the gate');
        await delay(10);
      }
    } else {
      fs.writeFileSync(${JSON.stringify(secondGate)}, 'entered');
      const until = Date.now() + 10000;
      while (!fs.existsSync(${JSON.stringify(raceLog)}) || fs.existsSync(${JSON.stringify(raceConfig + ".dispatch.lock")})) {
        if (Date.now() > until) throw Error('first dispatcher never finished');
        await delay(10);
      }
    }
    console.log('[]');
  } else if (process.argv[2] === 'run') {
    fs.appendFileSync(${JSON.stringify(raceLog)}, process.pid + '\\n');
    console.log('{}');
  } else { throw Error('unexpected fake CLI call'); }
})().catch(e => { console.error(e); process.exit(2); });
`);
  chmodSync(raceFake, 0o755);
  const dispatcher = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["-e", `require(${JSON.stringify(BUNDLE)}).wheelPass('interval').catch(e => { console.error(e); process.exitCode = 2; })`], {
      env: { ...process.env, PASEO_STEWARD_CONFIG: raceConfig, PASEO_BIN: raceFake },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { out += d; });
    p.on("error", reject);
    p.on("close", code => resolve({ code, out }));
  });
  const racers = await Promise.all([dispatcher(), dispatcher()]);
  const raceSpawns = existsSync(raceLog) ? readFileSync(raceLog, "utf8").trim().split("\n").filter(Boolean).length : 0;
  check("two concurrent dispatchers with stale snapshots reserve and spawn only once",
    racers.every(r => r.code === 0) && raceSpawns === 1 &&
    Boolean(JSON.parse(readFileSync(raceConfig, "utf8")).projects[0].lastDispatchAt) &&
    !existsSync(raceConfig + ".dispatch.lock") &&
    readFileSync(join(rRace, "control/COMMAND.md"), "utf8") === commandBefore,
    `${raceSpawns} spawn(s), child exits ${racers.map(r => r.code).join("/")}`);

  // 12. Review F3: an empty Ready table followed by a populated historical table must stay empty. The
  //     parser used to keep going until it had a row, consuming the Dispatch ledger as current work.
  const emptyReadyLayout = [
    "# COMMAND", "",
    "## Lease", "",
    "    session=pi:test",
    `    paseo-agent=${STEWARD}`,
    "    since=2026-10-19T00:00Z",
    `    heartbeat=${iso(0)}`,
    "    state=held",
    "",
    "## Ready queue", "",
    "| leg | goal |",
    "|---|---|",
    "",
    "## Dispatch ledger", "",
    "| leg | status | agent | note |",
    "|---|---|---|---|",
    "| 1 | done | worker | already finished |",
    "",
  ].join("\n");
  const rEmptyReady = project("empty-ready-table", emptyReadyLayout);
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "empty-ready-table", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rEmptyReady },
  ]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: rEmptyReady, status: "running" }]));
  writeCfg(row(rEmptyReady));
  m = fresh();
  const beforeEmptyReady = pokes().length;
  await m.wheelPass("interval");
  check("an empty Ready table does not read the Dispatch ledger as queued work",
    pokes().length === beforeEmptyReady, `${pokes().length - beforeEmptyReady} poke(s)`);

  // 13. Review F2: an unreadable agent list is UNKNOWN, never proof that the claim disappeared.
  const rUnknown = project("unknown-list", leaseBlock({}));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "unknown-list", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rUnknown },
  ]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: rUnknown, status: "running" }]));
  writeCfg(row(rUnknown));
  writeFileSync(listErrorFile, "1");
  m = fresh();
  const beforeUnknownSpawn = spawns().length;
  const beforeUnknownPoke = pokes().length;
  const unknownResult = await m.wheelPass("interval");
  check("an unreadable agent list starts no replacement steward",
    spawns().length === beforeUnknownSpawn, `${spawns().length - beforeUnknownSpawn} spawn(s)`);
  check("an unreadable agent list is reported as UNKNOWN",
    unknownResult.some((line) => /unreadable|UNKNOWN/i.test(line)), unknownResult.join(" · ") || "no result");
  check("an unreadable agent list does not count as a failed poke or void a claim",
    pokes().length === beforeUnknownPoke &&
      JSON.parse(readFileSync(cfgPath, "utf8")).projects[0].pokeFailureCount === 0,
    `${pokes().length - beforeUnknownPoke} poke(s)`);

  // Malformed output is the same UNKNOWN, not an empty list.
  rmSync(listErrorFile, { force: true });
  writeFileSync(agentsFile, JSON.stringify({ not: "an array" }));
  writeCfg(row(rUnknown));
  m = fresh();
  const beforeMalformed = spawns().length;
  const malformedResult = await m.wheelPass("interval");
  check("a malformed agent list starts no replacement steward",
    spawns().length === beforeMalformed, `${spawns().length - beforeMalformed} spawn(s)`);
  check("a malformed agent list is reported as UNKNOWN",
    malformedResult.some((line) => /unreadable|UNKNOWN/i.test(line)), malformedResult.join(" · ") || "no result");

  // 14. Failed deliveries persist across reloads; a running claim still blocks takeover.
  const rVoid = project("void-claim", leaseBlock({}));
  writeFileSync(workspacesFile, JSON.stringify([
    { project: "void-claim", workspaceId: "wks_test", name: "main", isolation: "local", cwd: rVoid },
  ]));
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, name: "s", cwd: rVoid, status: "running" }]));
  writeCfg(row(rVoid));
  writeFileSync(sendErrorFile, "1");
  const spawnsBeforeVoid = spawns().length;
  for (let i = 0; i < 3; i += 1) {
    // Age the dedupe stamp instead of the clock, and reload as the daemon does between pokes.
    patchCfg({ lastPokeAt: iso(-30) });
    m = fresh();
    await m.wheelPass("interval");
  }
  const voidRow = JSON.parse(readFileSync(cfgPath, "utf8")).projects[0];
  check("a failed poke is counted on disk across reloads",
    voidRow.pokeFailureCount === 3 && voidRow.pokeFailureAgent === STEWARD,
    `count=${voidRow.pokeFailureCount}`);
  check("three failed pokes do not replace the claim before the counter trips",
    spawns().length === spawnsBeforeVoid, `${spawns().length - spawnsBeforeVoid} spawn(s)`);
  // Failure count is not proof of absence. A subsequent error status permits takeover.
  m = fresh();
  await m.wheelPass("interval");
  check("a running claim blocks takeover after three failed pokes",
    spawns().length === spawnsBeforeVoid, `${spawns().length - spawnsBeforeVoid} spawn(s)`);
  check("failed count remains visible after the blocked beat",
    JSON.parse(readFileSync(cfgPath, "utf8")).projects[0].pokeFailureCount >= 3);
  writeFileSync(agentsFile, JSON.stringify([{ id: STEWARD, cwd: rVoid, status: "error" }]));
  m = fresh();
  await m.wheelPass("interval");
  check("an errored claim allows takeover after failed pokes",
    spawns().length === spawnsBeforeVoid + 1, `${spawns().length - spawnsBeforeVoid} spawn(s)`);
  rmSync(sendErrorFile, { force: true });

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`} — ${spawns().length} spawn(s), ${pokes().length} poke(s), ${wakes.length} wake(s)`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check crashed:", error);
  process.exit(2);
});
