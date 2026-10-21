#!/usr/bin/env node
/**
 * LEG 36 — a peer message reaches the right live agent directly, with the HCP fields intact.
 *
 * The target is resolved the same way dispatch.sh/reserve.sh resolve work: a workspace whose branch
 * (name) or directory names the task, or an agent whose title names it. The fake `paseo` records every
 * invocation; the check requires exactly ONE delivery call, addressed to that agent, carrying every HCP
 * line. No real agent is ever started.
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
const TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg36-"));
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

  // The agent's title deliberately does NOT name the task: the branch/directory must be enough.
  writeFileSync(AGENTS, JSON.stringify([
    {
      id: AGENT_ID,
      shortId: "b7e3c1a",
      name: "junior-b peer worker",
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
if (args[0] === "send") process.exit(0);
process.exit(0);
`, { mode: 0o755 });
  chmodSync(FAKE, 0o755);

  const result = runPeer([
    "T-152", "T-153",
    "--type", "ASK",
    "--ref", "docs/V1.1-DESIGN.md:12@a31f7c2",
    "--fact", "Frontend renders {items,total,nextCursor?}.",
    "--need", "Confirm nextCursor is still an optional string.",
    "--impact", "Pagination work is blocked.",
  ]);

  check("the sender gets SENT", () => {
    assert.equal(result.status, 0, `exit=${result.status} stderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), "SENT");
  });

  check("exactly one delivery call is made", () => {
    const sends = calls().filter((args) => args[0] === "send");
    assert.equal(sends.length, 1, `send calls=${JSON.stringify(sends)}`);
  });

  check("the delivery is addressed to the resolved agent id", () => {
    const send = calls().find((args) => args[0] === "send");
    assert.ok(send, "no send call");
    assert.equal(send[1], AGENT_ID, `sent to ${send[1]}`);
  });

  check("the delivery asks for steer without waiting", () => {
    const send = calls().find((args) => args[0] === "send");
    assert.ok(send.includes("--no-wait"), "missing --no-wait");
    const at = send.indexOf("--behavior");
    assert.ok(at >= 0 && send[at + 1] === "steer", "missing --behavior steer");
  });

  check("the HCP lines travel intact", () => {
    const send = calls().find((args) => args[0] === "send");
    const message = send[send.length - 1];
    for (const line of [
      "TYPE: ASK",
      "FROM: T-152",
      "TO: T-153",
      "REF: docs/V1.1-DESIGN.md:12@a31f7c2",
      "FACT: Frontend renders {items,total,nextCursor?}.",
      "NEED: Confirm nextCursor is still an optional string.",
      "IMPACT: Pagination work is blocked.",
    ]) {
      assert.ok(message.includes(line), `missing line: ${line}\nmessage=${message}`);
    }
  });

  check("the one-line peer log records the accepted attempt", () => {
    const log = path.join(OUT, "peer-log.jsonl");
    assert.ok(existsSync(log), "peer-log.jsonl is missing");
    const rows = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1, `rows=${rows.length}`);
    assert.deepEqual(
      { from: rows[0].from, to: rows[0].to, type: rows[0].type, ref: rows[0].ref, verdict: rows[0].verdict },
      { from: "T-152", to: "T-153", type: "ASK", ref: "docs/V1.1-DESIGN.md:12@a31f7c2", verdict: "SENT" },
    );
    assert.ok(rows[0].at, "at is recorded");
  });

  check("an idle delivery does not write an inbox line", () => {
    assert.ok(!existsSync(path.join(OUT, "peer-inbox-T-153.jsonl")), "unexpected inbox file");
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
