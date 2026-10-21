#!/usr/bin/env node
/**
 * LEG 39 — a routine peer message never interrupts a running turn.
 *
 * Running target: the message is appended to checks/out/peer-inbox-<task>.jsonl and the sender reads
 * QUEUED; no `paseo send` call is made. When the same agent is idle, the same message is delivered with
 * `paseo send --no-wait --behavior steer` and the sender reads SENT.
 */
const { spawnSync } = require("node:child_process");
const {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const REPO = path.resolve(__dirname, "..");
// Every case addresses the T-153 fixture; peer-send.sh refuses a task with no manifest before anything else.
const { skip, missingTask } = require("./preconditions.cjs");
const missingFixture = missingTask("T-153", REPO);
if (missingFixture) skip(missingFixture);
const TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg39-"));
const TASKS = path.join(TMP, "checks", "tasks");
const OUT = path.join(TMP, "checks", "out");
const AGENTS = path.join(TMP, "agents.json");
const WORKSPACES = path.join(TMP, "workspaces.json");
const CALLS = path.join(TMP, "calls.jsonl");
const FAKE = path.join(TMP, "paseo");
const AGENT_ID = "b7e3c1a2-1111-4222-8333-944455556666";
const WORKTREE = "/tmp/peer-demo/worktrees/paseo-t-153";
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

function calls() {
  if (!existsSync(CALLS)) return [];
  return readFileSync(CALLS, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).args);
}

function sends() {
  return calls().filter((args) => args[0] === "send");
}

function rows(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function runPeer(need) {
  return spawnSync("bash", [
    path.join(REPO, "tools", "peer-send.sh"),
    "T-152", "T-153",
    "--type", "ASK",
    "--ref", "src/api/users.ts:42@b78cd10",
    "--need", need,
  ], {
    encoding: "utf8",
    env: { ...process.env, PASEO_BIN: FAKE, PEER_REPO: TMP },
  });
}

function setStatus(status) {
  writeFileSync(AGENTS, JSON.stringify([
    {
      id: AGENT_ID,
      shortId: "b7e3c1a",
      name: "junior-b T-153",
      provider: "opencode/opencode/deepseek-v4.1-flash-free",
      status,
      cwd: WORKTREE,
    },
  ]));
}

function main() {
  cpSync(path.join(REPO, "checks", "tasks"), TASKS, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  writeFileSync(WORKSPACES, JSON.stringify([
    {
      workspaceId: "wks_peer_t153",
      project: "paseo-steward",
      name: "paseo/T-153",
      isolation: "worktree",
      cwd: WORKTREE,
    },
  ]));
  writeFileSync(FAKE, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "agent" && args[1] === "ls") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(AGENTS)}, "utf8"));
  process.exit(0);
}
if (args[0] === "workspace" && args[1] === "ls") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(WORKSPACES)}, "utf8"));
  process.exit(0);
}
if (args[0] === "send") process.exit(0);
process.exit(0);
`, { mode: 0o755 });
  chmodSync(FAKE, 0o755);

  setStatus("running");
  const busy = runPeer("Confirm nextCursor is optional.");

  check("a running target reads QUEUED", () => {
    assert.equal(busy.status, 0, `exit=${busy.status} stderr=${busy.stderr}`);
    assert.equal(busy.stdout.trim(), "QUEUED");
  });

  check("a running target receives zero delivery calls", () => {
    assert.deepEqual(sends(), [], `sends=${JSON.stringify(sends())}`);
  });

  check("the busy message lands in the task inbox", () => {
    const inbox = rows(path.join(OUT, "peer-inbox-T-153.jsonl"));
    assert.equal(inbox.length, 1, `rows=${inbox.length}`);
    assert.equal(inbox[0].from_task, "T-152");
    assert.equal(inbox[0].to_task, "T-153");
    assert.equal(inbox[0].type, "ASK");
    assert.equal(inbox[0].verdict, "QUEUED");
    assert.match(inbox[0].need, /nextCursor/);
  });

  check("the peer log records the queued attempt", () => {
    const log = rows(path.join(OUT, "peer-log.jsonl"));
    assert.equal(log.length, 1, `rows=${log.length}`);
    assert.equal(log[0].verdict, "QUEUED");
  });

  setStatus("idle");
  const idle = runPeer("Confirm nextCursor is optional after the checkpoint.");

  check("a later idle run sends", () => {
    assert.equal(idle.status, 0, `exit=${idle.status} stderr=${idle.stderr}`);
    assert.equal(idle.stdout.trim(), "SENT");
  });

  check("the idle run makes exactly one delivery call to the same agent", () => {
    const delivered = sends();
    assert.equal(delivered.length, 1, `sends=${JSON.stringify(delivered)}`);
    assert.equal(delivered[0][1], AGENT_ID);
  });

  check("the idle message carries the HCP body", () => {
    const send = sends()[0];
    const message = send[send.length - 1];
    assert.match(message, /^TYPE: ASK$/m);
    assert.match(message, /^FROM: T-152$/m);
    assert.match(message, /^TO: T-153$/m);
    assert.match(message, /^REF: src\/api\/users\.ts:42@b78cd10$/m);
    assert.match(message, /^NEED: Confirm nextCursor is optional after the checkpoint\.$/m);
  });

  check("the peer log keeps both attempts, in order", () => {
    const log = rows(path.join(OUT, "peer-log.jsonl"));
    assert.deepEqual(log.map((row) => row.verdict), ["QUEUED", "SENT"]);
  });

  check("the queued message is not rewritten by the later send", () => {
    assert.equal(rows(path.join(OUT, "peer-inbox-T-153.jsonl")).length, 1);
  });
}

try {
  main();
} catch (error) {
  console.error("check crashed:", error);
  failures += 1;
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nOK" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
