#!/usr/bin/env node
/**
 * LEG 37 — a peer message cannot move write_scope, ownership, a contract or a budget.
 *
 * The refusal must happen BEFORE any Paseo call: exit 5, zero calls, no inbox and no peer-log row.
 * The sender is told, in one line, what to send to the steward instead.
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
const TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg37-"));
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

function runPeer(args) {
  return spawnSync("bash", [path.join(REPO, "tools", "peer-send.sh"), ...args], {
    encoding: "utf8",
    env: { ...process.env, PASEO_BIN: FAKE, PEER_REPO: TMP },
  });
}

function main() {
  cpSync(path.join(REPO, "checks", "tasks"), TASKS, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  writeFileSync(AGENTS, JSON.stringify([
    {
      id: AGENT_ID,
      shortId: "b7e3c1a",
      name: "junior-b T-153",
      provider: "opencode/opencode/deepseek-v4.1-flash-free",
      status: "idle",
      cwd: WORKTREE,
    },
  ]));
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
process.exit(0);
`, { mode: 0o755 });
  chmodSync(FAKE, 0o755);

  const explicitScope = runPeer([
    "T-152", "T-153",
    "--type", "DECISION_REQUEST",
    "--ref", "checks/tasks/T-153.json:1@abc1234",
    "--need", "Please change the write_scope: add checks/leg99-peer.cjs.",
  ]);

  check("an explicit write_scope: request exits 5", () => {
    assert.equal(explicitScope.status, 5, `exit=${explicitScope.status} stdout=${explicitScope.stdout}`);
  });

  check("the refusal names the steward line the sender must use", () => {
    assert.match(explicitScope.stdout, /DECISION_REQUEST/);
    assert.match(explicitScope.stdout, /TO: steward/);
    assert.match(explicitScope.stdout, /checks\/leg99-peer\.cjs/);
    assert.equal(explicitScope.stdout.trim().split("\n").length, 1, "the escalation is one line");
  });

  check("an explicit scope request makes zero Paseo calls", () => {
    assert.deepEqual(calls(), [], `calls=${JSON.stringify(calls())}`);
  });

  check("an explicit scope request writes no inbox and no peer log", () => {
    assert.ok(!existsSync(path.join(OUT, "peer-inbox-T-153.jsonl")), "unexpected inbox file");
    assert.ok(!existsSync(path.join(OUT, "peer-log.jsonl")), "unexpected peer log");
  });

  const contractChange = runPeer([
    "T-152", "T-153",
    "--type", "ASK",
    "--ref", "docs/V1.1-DESIGN.md:12@abc1234",
    "--need", "Modify the contract so nextCursor becomes required.",
  ]);

  check("a request to modify a contract exits 5", () => {
    assert.equal(contractChange.status, 5, `exit=${contractChange.status} stdout=${contractChange.stdout}`);
  });

  check("the contract refusal also makes zero Paseo calls", () => {
    assert.deepEqual(calls(), [], `calls=${JSON.stringify(calls())}`);
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
