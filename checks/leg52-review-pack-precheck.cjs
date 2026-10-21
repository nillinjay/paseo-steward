#!/usr/bin/env node
/**
 * LEG 52 — a review packet is validated before a model is paid for.
 *
 * Twice on 2026-10-21 a reviewer answered "cannot determine" because the packet lacked an engine. `tools/digest.sh`
 * now writes `<packet>.meta.json` (each engine's spec, lines and sha256), `tools/review-pack-validate.mjs` checks the
 * packet against it, and `tools/dispatch.sh` refuses a `review-*` dispatch (exit 9) whose packet fails. The dispatcher
 * is driven against a throwaway steward tree with a stand-in `paseo` that touches a marker when an agent is started.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const REPO = path.resolve(__dirname, "..");
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "steward-leg52-")));
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

// A throwaway steward tree: the real tools, the real roster, a source file to extract from.
const steward = path.join(TMP, "steward");
fs.mkdirSync(path.join(steward, "control"), { recursive: true });
fs.mkdirSync(path.join(steward, "reviews"), { recursive: true });
fs.mkdirSync(path.join(steward, "checks", "tasks"), { recursive: true });
fs.cpSync(path.join(REPO, "tools"), path.join(steward, "tools"), { recursive: true });
fs.cpSync(path.join(REPO, "control", "roster.json"), path.join(steward, "control", "roster.json"));
fs.writeFileSync(path.join(steward, "engine.ts"), ["export function a() {", "  return 1;", "}", "export const b = 2;", ""].join("\n"));

function digest(name, judge) {
  const r = spawnSync("bash", [path.join(steward, "tools", "digest.sh"), `reviews/${name}`, judge, "engine.ts:1-3", "engine.ts:4,4"],
    { cwd: steward, encoding: "utf8" });
  assert.equal(r.status, 0, `digest exit ${r.status}: ${r.stderr}`);
  return path.join(steward, "reviews", name);
}
function validate(packet) {
  return spawnSync("node", [path.join(steward, "tools", "review-pack-validate.mjs"), packet], { encoding: "utf8" });
}
function rejects(packet, pattern) {
  const r = validate(packet);
  assert.notEqual(r.status, 0, `accepted: ${r.stdout}`);
  assert.equal(r.stderr.trim().split("\n").length, 1, `one line, got: ${r.stderr}`);
  assert.match(r.stderr, pattern);
}

check("digest.sh writes a sidecar with each engine's spec, lines and sha256", () => {
  const packet = digest("packet-good.md", "is a() right?");
  const meta = JSON.parse(fs.readFileSync(`${packet}.meta.json`, "utf8"));
  assert.equal(meta.judge_present, true);
  assert.ok(!Number.isNaN(Date.parse(meta.created_at)), "created_at is a timestamp");
  assert.deepEqual(meta.engines.map((e) => [e.spec, e.lines]), [["engine.ts:1-3", 3], ["engine.ts:4,4", 1]]);
  for (const e of meta.engines) assert.match(e.sha256, /^[0-9a-f]{64}$/);
});
check("a good packet with its sidecar passes", () => {
  const r = validate(path.join(steward, "reviews", "packet-good.md"));
  assert.equal(r.status, 0, r.stderr);
});
check("a packet edited after the sidecar fails", () => {
  const packet = digest("packet-edited.md", "is a() right?");
  fs.writeFileSync(packet, fs.readFileSync(packet, "utf8").replace("return 1;", "return 2;"));
  rejects(packet, /engine engine\.ts:1-3: extracted text changed/);
});
check("a packet that lost an engine fails", () => {
  const packet = digest("packet-lost.md", "is a() right?");
  fs.writeFileSync(packet, fs.readFileSync(packet, "utf8").replace("## engine.ts:4-4", "## gone"));
  rejects(packet, /engine engine\.ts:4,4: marker "## engine\.ts:4-4" is not in the packet/);
});
check("a packet without \"What to judge\" fails", () => {
  const packet = digest("packet-nojudge.md", "is a() right?");
  fs.writeFileSync(packet, fs.readFileSync(packet, "utf8").replace(/^\*\*What to judge\.\*\*.*$/m, "**What to judge.**   "));
  rejects(packet, /no "What to judge" text/);
});
check("a sidecar with no engine fails", () => {
  const packet = digest("packet-empty.md", "is a() right?");
  const meta = JSON.parse(fs.readFileSync(`${packet}.meta.json`, "utf8"));
  fs.writeFileSync(`${packet}.meta.json`, JSON.stringify({ ...meta, engines: [] }));
  rejects(packet, /lists no engine/);
});
check("a missing sidecar fails", () => {
  const packet = digest("packet-nosidecar.md", "is a() right?");
  fs.rmSync(`${packet}.meta.json`);
  rejects(packet, /sidecar not found/);
});
check("a missing packet fails", () => {
  rejects(path.join(steward, "reviews", "packet-absent.md"), /packet not found/);
});

// The dispatcher refuses a review leg on a bad packet before it reserves, creates or starts anything.
const home = path.join(TMP, "paseo-home");
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ daemon: { agentProfiles: [{ name: "review-codex", provider: "codex", model: "x" }] } }));
const marker = path.join(TMP, "started");
const fake = path.join(TMP, "paseo");
fs.writeFileSync(fake, `#!/usr/bin/env node
const args = process.argv.slice(2);
require("node:fs").appendFileSync(${JSON.stringify(marker)}, JSON.stringify(args) + "\\n");
if (args[0] === "run") process.stdout.write("agent-952\\n");
else if (args[1] === "ls") process.stdout.write("[]");
`, { mode: 0o755 });

function reviewDispatch(task, packet) {
  fs.rmSync(marker, { force: true });
  fs.writeFileSync(path.join(steward, "checks", "tasks", `${task}.json`), JSON.stringify({ task_id: task, allowed_commands: [] }));
  const brief = [`task_id: ${task}`, `read_scope: reviews/${packet}`, "", "Judge the packet."].join("\n");
  return spawnSync("bash", [path.join(steward, "tools", "dispatch.sh"), task, "--role", "review-codex", "--", "--title", `${task} review`, brief],
    { encoding: "utf8", env: { ...process.env, PASEO_BIN: fake, PASEO_HOME: home } });
}

for (const [label, packet] of [["edited", "packet-edited.md"], ["missing sidecar", "packet-nosidecar.md"], ["absent", "packet-absent.md"]]) {
  check(`a review dispatch on a bad packet (${label}) exits 9 and starts nothing`, () => {
    const r = reviewDispatch("T-952", packet);
    assert.equal(r.status, 9, `exit ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /review packet failed validation/);
    assert.ok(!fs.existsSync(marker), `paseo was invoked: ${fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : ""}`);
    assert.ok(!fs.existsSync(path.join(steward, ".locks", "T-952.json")), "nothing was reserved");
  });
}
check("a review dispatch with no packet on read_scope exits 9 and starts nothing", () => {
  const r = reviewDispatch("T-952", "notes.md");
  assert.equal(r.status, 9, `exit ${r.status}: ${r.stderr}`);
  assert.ok(!fs.existsSync(marker), "paseo was invoked");
});
check("a review dispatch on a good packet gets through and starts the reviewer", () => {
  const r = reviewDispatch("T-955", "packet-good.md");
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  assert.ok(fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes('"run"'), "the reviewer was started");
});

fs.rmSync(TMP, { recursive: true, force: true });
if (failures) {
  console.log(`FAIL  leg52: ${failures} failing`);
  process.exit(1);
}
console.log("leg52 review-pack precheck ok");
