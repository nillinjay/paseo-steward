#!/usr/bin/env node
/**
 * LEG 12 acceptance — a shell request must not be a dead end.
 *
 * Measured failure, 2026-10-19: two codex workers sat **25 minutes** on one pending `CodexBash` request each.
 * The policy answered plan exits and questions and left everything else pending "for the human", which is
 * correct for a file delete and wrong for `ls`. A worker that must ask a human for every command cannot
 * work unattended, so 懒人模式 stalls on its first non-pi worker.
 *
 * Policy c: a shell request is answered by `autoAllowShell` (default on), and every answer is audited like
 * any other. Turn it off and shell requests go back to pending.
 */
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");
const path = require("node:path");
const { tmpdir } = require("node:os");
const os = require("node:os");

const REPO = join(__dirname, "..");
const SERVER = "/tmp/steward-leg12-server.cjs";
const SHARED = "/tmp/steward-leg12-shared.cjs";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function main() {
  for (const [entry, out] of [["server/steward.ts", SERVER], ["shared/steward.ts", SHARED]]) {
    execFileSync("npx", ["esbuild", entry, "--bundle", "--platform=node", "--format=cjs", "--outfile=" + out, "--external:@getpaseo/*"], { cwd: REPO, stdio: "ignore" });
  }
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const shared = require(SHARED);
  const server = require(SERVER);
  const cfg = (patch) => ({
    root: "/tmp/x", workspace: "wks", provider: "pi/x", thinking: "high",
    juniorProvider: "opencode/x", intervalMinutes: 20, nextTickAt: null, lastDispatchAt: null,
    lastPokeAt: null, lastPokeFingerprint: null, lazyMode: true, enabled: true,
    leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true, autoAllowShell: true, ...patch,
  });

  // 1. Classification: the SDK kind is authoritative, and a shell tool is recognised by name.
  check('classifyRequest("CodexBash") is shell', shared.classifyRequest("CodexBash", "other") === "shell");
  check('classifyRequest("Bash") is shell', shared.classifyRequest("Bash") === "shell");
  check('classifyRequest("ExitPlanMode", "plan") is plan', shared.classifyRequest("ExitPlanMode", "plan") === "plan");
  check('classifyRequest("AskUserQuestion", "question") is question', shared.classifyRequest("AskUserQuestion", "question") === "question");
  // Independent review of LEG 5, Finding 3: a shell-shaped name carrying kind "plan" must NOT be auto-allowed.
  check('a shell name with kind "plan" is not shell', shared.classifyRequest("Bash", "plan") !== "shell",
    `got ${shared.classifyRequest("Bash", "plan")}`);
  check('a shell name with kind "question" is not shell', shared.classifyRequest("Bash", "question") !== "shell");
  // A file write is not a blanket question any more: the PATH decides. Inside the worker's own worktree it is
  // the work; anywhere else it stays with the human. The old blanket rule stalled a claude worker on editing
  // its own `client/strings.ts` (2026-10-20), and unbounded writes are still refused below by decideEdit.
  check('classifyRequest("WriteFile") is an edit', shared.classifyRequest("WriteFile", "other") === "edit",
    "a file write must be classified by its path, not answered blindly");
  check('a WriteFile outside the worktree still reaches the human',
    server.decideEdit(cfg({}), "/home/dev/work", JSON.stringify({ file_path: "/home/dev/code/paseo-steward/x.ts" })) === null);

  // 2. Policy: shell follows its own switch, and turning it off restores the dead end deliberately.
  // A worker writing scratch to /tmp asked for permission 4 times in one day and stalled twice. /tmp is
  // scratch; any other out-of-project path is still the human's decision.
  check('classifyRequest("external_directory", "other", "Scope: /tmp/*") is temp',
    shared.classifyRequest("external_directory", "other", "Scope: /tmp/*") === "temp");
  check('classifyRequest("external_directory", "other", "Scope: /home/other/*") is external',
    shared.classifyRequest("external_directory", "other", "Scope: /home/other/*") === "external");
  // The exact string the daemon sends, including the empty input object the handler joins in.
  check("the vendor's exact description classifies as temp",
    shared.classifyRequest("external_directory", "other", 'Scope: /tmp/* {}') === "temp");
  // Review F6: a request that mentions /tmp AND another directory must stay pending.
  check('a mixed scope is not temp', shared.classifyRequest("external_directory", "tool", "Scope: /tmp/*, /home/private/*") === "external");
  check('a single non-temp scope is not temp', shared.classifyRequest("external_directory", "tool", "Scope: /home/private/*") === "external");
  // The Paseo source tree is a deployment detail, not a constant: it is named by PASEO_SOURCE_ROOT, and with no
  // environment there is no `source` class at all (a path we cannot locate is `external`).
  // Not under /tmp: /tmp classifies as `temp` before any other rule, so a fixture there would test nothing.
  const sourceRoot = path.join(os.homedir(), '.paseo-src-fixture');
  process.env.PASEO_SOURCE_ROOT = sourceRoot;
  check('reading the configured source tree is source',
    shared.classifyRequest("external_directory", "tool", `Scope: ${sourceRoot}/packages/cli/src/*`) === "source");
  check('a temp+source mix is neither', shared.classifyRequest("external_directory", "tool", `Scope: /tmp/*, ${sourceRoot}/x`) === "external");
  delete process.env.PASEO_SOURCE_ROOT;
  check('with no configured source root, that path is external',
    shared.classifyRequest("external_directory", "tool", `Scope: ${sourceRoot}/packages/cli/src/*`) === "external");
  check("source reads are allowed when the policy is on", server.decide("source", cfg({})) === "allow");
  // A worker opened real Chrome windows on the owner's desktop by running `chrome-use --session t113`.
  check('chrome-use is blocked, not deferred',
    shared.classifyRequest("CodexBash", "other", '{"command":"chrome-use --session t113 read https://x"}') === "blocked");
  check("a blocked launch is denied outright", server.decide("blocked", cfg({})) === "deny");
  // The claude worker stalled on `Edit client/strings.ts` — its own file, inside its own worktree (2026-10-20).
  check("an edit request is its own class", shared.classifyRequest("Edit", "tool", '{"file_path":"/w/client/strings.ts"}') === "edit");
  const WORK = "/home/dev/code/paseo/.dev/paseo-home/worktrees/x/paseo-t-115";
  check("an edit inside the worker's worktree is allowed",
    server.decideEdit(cfg({}), WORK, JSON.stringify({ file_path: WORK + "/client/strings.ts" })) === "allow");
  check("an edit outside the worktree stays with the human",
    server.decideEdit(cfg({}), WORK, JSON.stringify({ file_path: "/home/dev/code/paseo-steward/server/steward.ts" })) === null);
  check("a sibling worktree is outside too",
    server.decideEdit(cfg({}), WORK, JSON.stringify({ file_path: WORK + "-other/client/x.ts" })) === null);
  check("an edit with no path stays with the human", server.decideEdit(cfg({}), WORK, '{"content":"x"}') === null);
  // Scratch written directly rather than through external_directory.
  check("a Write into /tmp is scratch, not a decision",
    server.decideEdit(cfg({}), WORK, JSON.stringify({ file_path: "/tmp/t121/repro.cjs", content: "x" })) === "allow");
  // A worker's real request carried a relative path in its command text; the old regex read the tail
  // (`/repro-review2.cjs`) as an absolute path and parked a legitimate /tmp scope (T-120, 2026-10-20).
  check("a relative path in the command does not poison a /tmp scope",
    shared.classifyRequest("external_directory", "tool",
      'Scope: /tmp/* {"patterns":["/tmp/*"],"directories":["/tmp"],"metadata":{"command":"node checks/repro-review2.cjs > /tmp/x.log 2>&1"}}') === "temp");
  check("a glob scope is temporary", shared.classifyRequest("external_directory", "tool", "Scope: /tmp/*") === "temp");
  // Review N2: traversal must not look temporary.
  check("traversal out of /tmp is not temporary",
    shared.classifyRequest("external_directory", "tool", "Scope: /tmp/../home/private/*") === "external");
  check("traversal out of the Paseo tree is not source",
    shared.classifyRequest("external_directory", "tool", "Scope: /home/dev/code/paseo/../private/*") === "external");
  // A project may declare reference trees it reads without asking. The torchfdtd worker studying its own
  // library at a second checkout stalled on exactly this (2026-10-20).
  check("a declared reference root is readable",
    server.decideReference(cfg({ readOnlyRoots: ["/data/nil-home/FDTD/torchfdtd"] }),
      'Scope: /data/nil-home/FDTD/torchfdtd/* {"patterns":["/data/nil-home/FDTD/torchfdtd/*"]}') === "allow");
  check("a path next to the reference root is not",
    server.decideReference(cfg({ readOnlyRoots: ["/data/nil-home/FDTD/torchfdtd"] }),
      'Scope: /data/nil-home/FDTD/other/*') === null);
  check("no declared roots means no reference reads",
    server.decideReference(cfg({}), 'Scope: /data/nil-home/FDTD/torchfdtd/*') === null);
  check("temp scratch is allowed when the policy is on", server.decide("temp", cfg({})) === "allow");
  check("temp scratch is pending when the policy is off",
    server.decide("temp", cfg({ autoAllowShell: false })) === null);
  check("any other external path is never answered", server.decide("external", cfg({})) === null,
    "reading someone else's tree is not a scratch decision");

  check("a shell request is allowed when the policy is on", server.decide("shell", cfg({})) === "allow");
  check("a shell request stays pending when the policy is off", server.decide("shell", cfg({ autoAllowShell: false })) === null);
  check("turning shell on does not weaken the question policy",
    server.decide("question", cfg({ autoDenyQuestions: false })) === null);
  check("a plan exit still needs its own switch",
    server.decide("plan", cfg({ autoAllowPlanExit: false })) === null);
  check("an unknown request is never answered", server.decide("other", cfg({})) === null);

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

// v1.0 ships with automatic shell approval OFF (owner ruling, 2026-10-21, option A). A project that has not opted
// in leaves every command pending: the whole class of "a regex missed a write mode" disappears from the default path.
{
  const base = cfg({});
  const off = { ...base, autoAllowShell: false };
  check("with the shipped default, a shell command is not answered", server.decide("shell", off) === null);
  check("with the shipped default, /tmp scratch is not answered either", server.decide("temp", off) === null);
  check("with the shipped default, a worktree edit is not answered", server.decideEdit(off, "/w", '{"file_path":"/w/x.ts"}') === null);
}
