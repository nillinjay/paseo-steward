#!/usr/bin/env node
/**
 * LEG 51 — the dispatcher owns the task manifest.
 *
 * On 2026-10-21 three legs failed their gate on tier / brief_kind / expires_at / p0_or_p1 because the worker wrote
 * its own manifest. `tools/task-manifest.cjs` derives every key from what the dispatcher knows and refuses (exit 3)
 * what it cannot derive; `tools/dispatch.sh` writes the result atomically before it launches anything. The tool is
 * driven for real, and the dispatcher is driven against a throwaway steward tree and a stand-in `paseo`.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const { skip, missingTask, headCommit } = require("./preconditions.cjs");

const REPO = path.resolve(__dirname, "..");
// The tool learns the manifest shape from an accepted manifest in checks/tasks/, and the dispatcher cases copy T-185.
const missingFixture = missingTask("T-185", REPO);
if (missingFixture) skip(`${missingFixture} (an accepted manifest the tool learns its shape from)`);
// Any real commit will do; it is this tree's own HEAD so the brief never names a commit the tree lacks.
const BASE = headCommit(REPO);
if (!BASE) skip("the tree under test has no commit to use as a brief's base");
const TOOL = path.join(REPO, "tools", "task-manifest.cjs");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "steward-leg51-")));
const REQUIRED = ["task_id", "lane", "risk", "base", "write_scope", "forbidden", "ops_actions", "acceptance",
  "tier", "p0_or_p1", "brief_kind", "expires_at", "cancel_how", "allowed_commands"];
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

const BRIEF = [
  "task_id: T-951",
  "lane: standard | risk: R2",
  `base: ${BASE} (branch paseo/T-951)`,
  "write_scope: tools/a.sh, checks/b.cjs",
  "forbidden: client/, shared/",
  "acceptance: npx tsc --noEmit=0; ./tools/suite.sh=0",
  "allowed_commands: npx tsc --noEmit | ./tools/suite.sh | git status",
  "",
  "Do the thing.",
].join("\n");
const briefFile = path.join(TMP, "brief.txt");
fs.writeFileSync(briefFile, BRIEF);

function tool(args) {
  return spawnSync("node", [TOOL, "--brief", briefFile, ...args], { encoding: "utf8" });
}
const FULL = ["--task", "T-951", "--role", "junior-a", "--risk", "R2", "--cancel-how", "revert the commit"];

check("full arguments produce a manifest with every required key", () => {
  const outDir = path.join(TMP, "full");
  const out = path.join(outDir, "T-951.json");
  const r = tool([...FULL, "--out", out]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(fs.readFileSync(out, "utf8"));
  for (const key of REQUIRED) assert.ok(key in m, `missing ${key}`);
  assert.deepEqual(JSON.parse(r.stdout), m, "stdout and the written file agree");
  assert.equal(m.tier, "junior");
  assert.equal(m.brief_kind, "delivery");
  assert.equal(m.p0_or_p1, "P0");
  assert.equal(m.expires_at, null);
  assert.equal(m.risk, "R2");
  assert.equal(m.base, BASE);
  assert.equal(m.lane, "standard");
  assert.deepEqual(m.write_scope, ["tools/a.sh", "checks/b.cjs"]);
  assert.deepEqual(m.forbidden, ["client/", "shared/"]);
  assert.deepEqual(m.ops_actions, []);
  assert.deepEqual(m.acceptance, [{ kind: "cmd", cmd: "npx tsc --noEmit" }, { kind: "cmd", cmd: "./tools/suite.sh" }]);
  assert.deepEqual(m.allowed_commands, ["npx tsc --noEmit", "./tools/suite.sh", "git status"]);
  assert.equal(m.cancel_how, "revert the commit");
  assert.deepEqual(fs.readdirSync(outDir), ["T-951.json"], "the write is atomic: no temp file is left behind");
});

function refused(args, pattern) {
  const out = path.join(TMP, `refused-${Math.random().toString(36).slice(2)}`, "T-951.json");
  const r = tool([...args, "--out", out]);
  assert.equal(r.status, 3, `exit ${r.status}: ${r.stderr}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `one line, got: ${r.stderr}`);
  assert.match(r.stderr, pattern);
  assert.equal(r.stdout, "");
  assert.ok(!fs.existsSync(path.dirname(out)), "a refusal writes nothing");
}

check("missing risk refuses with exit 3", () => {
  refused(["--task", "T-951", "--role", "junior-a", "--cancel-how", "x"], /--risk must be passed/);
});
check("a risk outside R0/R1/R2 refuses", () => {
  refused([...FULL.slice(0, 4), "--risk", "R3", "--cancel-how", "x"], /not R0, R1 or R2/);
});
check("missing cancel_how refuses; no text is invented", () => {
  refused(["--task", "T-951", "--role", "junior-a", "--risk", "R1"], /--cancel-how must be passed/);
});
check("external acceptance without --expires refuses", () => {
  refused([...FULL, "--acceptance", "npx tsc --noEmit=0; external: owner"], /kind: external but no --expires/);
  refused([...FULL, "--acceptance", JSON.stringify([{ kind: "external", party: "owner" }])], /kind: external/);
});
check("external acceptance with --expires carries the deadline", () => {
  const r = tool([...FULL, "--acceptance", "external: owner", "--expires", "2026-10-28T00:00:00Z"]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.expires_at, "2026-10-28T00:00:00Z");
  assert.deepEqual(m.acceptance, [{ kind: "external", party: "owner" }]);
});
check("review role -> brief_kind: review, tier senior", () => {
  const r = tool(["--task", "T-951", "--role", "review-codex", "--risk", "R0", "--cancel-how", "x"]);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout);
  assert.equal(m.brief_kind, "review");
  assert.equal(m.tier, "senior");
});
check("junior-b is junior, senior-sol is senior", () => {
  assert.equal(JSON.parse(tool([...FULL.slice(0, 2), "--role", "junior-b", ...FULL.slice(4)]).stdout).tier, "junior");
  assert.equal(JSON.parse(tool([...FULL.slice(0, 2), "--role", "senior-sol", ...FULL.slice(4)]).stdout).tier, "senior");
});
check("a brief without a 40-hex base refuses", () => {
  const r = spawnSync("node", [TOOL, ...FULL, "--write-scope", "a", "--forbidden", "b", "--acceptance", "x=0", "--lane", "fast"], { encoding: "utf8" });
  assert.equal(r.status, 3, r.stderr);
  assert.match(r.stderr, /cannot derive base/);
});
check("the shape comes from an accepted example: a type the example contradicts refuses", () => {
  refused([...FULL, "--overrides", JSON.stringify({ write_scope: "tools/a.sh" })], /"write_scope" is string/);
});

// The dispatcher: writes the manifest, then launches; refuses (and launches nothing) when the manifest cannot be built.
const steward = path.join(TMP, "steward");
fs.mkdirSync(path.join(steward, "control"), { recursive: true });
fs.cpSync(path.join(REPO, "tools"), path.join(steward, "tools"), { recursive: true });
fs.cpSync(path.join(REPO, "control", "roster.json"), path.join(steward, "control", "roster.json"));
fs.mkdirSync(path.join(steward, "checks", "tasks"), { recursive: true });
fs.cpSync(path.join(REPO, "checks", "tasks", "T-185.json"), path.join(steward, "checks", "tasks", "T-185.json"));
const home = path.join(TMP, "paseo-home");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { agentProfiles: [{ name: "junior-a", provider: "opencode", model: "x" }] } }));
const ran = path.join(TMP, "ran");
const fake = path.join(TMP, "paseo");
fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "run") { require("node:fs").writeFileSync(${JSON.stringify(ran)}, "x"); process.stdout.write("agent-951\\n"); }
else if (args[1] === "ls") process.stdout.write("[]");
`, { mode: 0o755 });

function dispatch(task, flags) {
  fs.rmSync(ran, { force: true });
  return spawnSync("bash", [path.join(steward, "tools", "dispatch.sh"), task, "--role", "junior-a", ...flags, "--",
    "--title", `${task} leg`, BRIEF.replace(/T-951/g, task)], {
    encoding: "utf8", env: { ...process.env, PASEO_BIN: fake, PASEO_HOME: home },
  });
}

check("dispatch.sh writes the complete manifest, then launches", () => {
  const r = dispatch("T-951", ["--risk", "R2", "--cancel-how", "revert the commit"]);
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const m = JSON.parse(fs.readFileSync(path.join(steward, "checks", "tasks", "T-951.json"), "utf8"));
  for (const key of REQUIRED) assert.ok(key in m, `missing ${key}`);
  assert.equal(m.task_id, "T-951");
  assert.equal(m.tier, "junior");
  assert.ok(fs.existsSync(ran), "the agent was started after the manifest was written");
  assert.deepEqual(fs.readdirSync(path.join(steward, "checks", "tasks")).filter((f) => f.includes(".tmp")), [], "no temp file is left behind");
  const lock = JSON.parse(fs.readFileSync(path.join(steward, ".locks", "T-951.json"), "utf8"));
  assert.deepEqual(lock.allowed_commands, ["npx tsc --noEmit", "./tools/suite.sh", "git status"], "the snapshot reads the manifest the dispatcher wrote");
});
check("dispatch.sh with --cancel-how but no --risk refuses and starts nothing", () => {
  const r = dispatch("T-953", ["--cancel-how", "x"]);
  assert.equal(r.status, 10, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /--risk must be passed/);
  assert.ok(!fs.existsSync(ran), "no agent was started");
  assert.ok(!fs.existsSync(path.join(steward, "checks", "tasks", "T-953.json")), "no manifest was written");
  assert.ok(!fs.existsSync(path.join(steward, ".locks", "T-953.json")), "the reservation was released");
});
check("dispatch.sh with no manifest and no manifest flags refuses and starts nothing", () => {
  const r = dispatch("T-954", []);
  assert.equal(r.status, 10, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /no manifest for T-954/);
  assert.ok(!fs.existsSync(ran), "no agent was started");
});

fs.rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.log(`FAIL  leg51: ${failures} failing`);
  process.exit(1);
}
console.log("leg51 dispatcher manifest ok");
