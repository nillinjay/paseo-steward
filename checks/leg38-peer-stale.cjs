#!/usr/bin/env node
/**
 * LEG 38 — a stale or absent attempt cannot act as the task's current fact or authority.
 *
 * The task manifest may exist, but if Paseo has no live agent for it the message must not be sent:
 * exit 4, zero delivery calls, no inbox and no peer-log row. An errored/closed agent is not live.
 */
const { spawnSync } = require("node:child_process");
const {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const REPO = path.resolve(__dirname, "..");
const TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg38-"));
const TASKS = path.join(TMP, "checks", "tasks");
const OUT = path.join(TMP, "checks", "out");
const AGENTS = path.join(TMP, "agents.json");
const WORKSPACES = path.join(TMP, "workspaces.json");
const CALLS = path.join(TMP, "calls.jsonl");
const FAKE = path.join(TMP, "paseo");
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

function resetCalls() {
  rmSync(CALLS, { force: true });
}

function runPeer() {
  return spawnSync("bash", [
    path.join(REPO, "tools", "peer-send.sh"),
    "T-152", "T-153",
    "--type", "ASK",
    "--ref", "src/api/users.ts:42@b78cd10",
    "--need", "Is nextCursor still optional?",
  ], {
    encoding: "utf8",
    env: { ...process.env, PASEO_BIN: FAKE, PEER_REPO: TMP },
  });
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
process.exit(0);
`, { mode: 0o755 });
  chmodSync(FAKE, 0o755);

  // The worktree still exists, but no agent is attached to it: the attempt is gone.
  writeFileSync(AGENTS, JSON.stringify([
    {
      id: "cccccccc-1111-4222-8333-944455556666",
      shortId: "ccccccc",
      name: "some other worker",
      provider: "opencode/opencode/deepseek-v4.1-flash-free",
      status: "idle",
      cwd: "/tmp/peer-demo/worktrees/unrelated",
    },
  ]));
  const absent = runPeer();

  check("a task whose agent is absent exits 4", () => {
    assert.equal(absent.status, 4, `exit=${absent.status} stdout=${absent.stdout} stderr=${absent.stderr}`);
  });

  check("an absent attempt receives zero delivery calls", () => {
    assert.deepEqual(sends(), [], `sends=${JSON.stringify(sends())}`);
  });

  check("an absent attempt writes no inbox and no peer log", () => {
    assert.ok(!existsSync(path.join(OUT, "peer-inbox-T-153.jsonl")), "unexpected inbox file");
    assert.ok(!existsSync(path.join(OUT, "peer-log.jsonl")), "unexpected peer log");
  });

  // A stale agent still listed with an error status is not live either.
  resetCalls();
  writeFileSync(AGENTS, JSON.stringify([
    {
      id: "dddddddd-1111-4222-8333-944455556666",
      shortId: "ddddddd",
      name: "T-153 old attempt",
      provider: "opencode/opencode/deepseek-v4.1-flash-free",
      status: "error",
      cwd: WORKTREE,
    },
  ]));
  const errored = runPeer();

  check("an errored attempt exits 4", () => {
    assert.equal(errored.status, 4, `exit=${errored.status} stdout=${errored.stdout} stderr=${errored.stderr}`);
  });

  check("an errored attempt receives zero delivery calls", () => {
    assert.deepEqual(sends(), [], `sends=${JSON.stringify(sends())}`);
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
