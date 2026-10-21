#!/usr/bin/env node
/**
 * LEG 19 acceptance — onboarding is a gate report, not a claim.
 *
 * A folder becomes a steward project only when seven facts hold: the four files, a repository with a
 * commit, a Paseo project id, a local workspace id, a runnable acceptance command, a truthful one-screen
 * RESUME, and plan.md carrying the four owner-supplied field headings.
 *
 * This check builds throwaway folders and a fake `paseo`, so no real project is touched:
 *   (a) a virgin folder gets all seven gates, is git-initialised once, and is registered once;
 *   (b) a second run is idempotent: no new commit, no new project/workspace, same content and ids;
 *   (c) a folder that already has its own commit history is refused, with the reason, before any write.
 * It also proves the report can turn green once the owner supplies a runnable acceptance command.
 */
const { execFileSync } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const SERVER = "/tmp/steward-leg19-server.cjs";
const TMP = join(os.tmpdir(), `leg19-${process.pid}`);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function filesUnder(root) {
  return ["README.md", "AGENTS.md", "plan.md", "STATUS.md", "control/COMMAND.md", "control/RESUME.md", "output/status-one-pager.md"]
    .map((path) => [path, existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null]);
}

async function main() {
  execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + SERVER, "--external:@getpaseo/*",
  ], { cwd: REPO, stdio: "ignore" });

  mkdirSync(TMP, { recursive: true });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const fake = join(TMP, "fake-paseo");
  const argvLog = join(TMP, "argv.log");
  const projectsFile = join(TMP, "projects.json");
  const workspacesFile = join(TMP, "workspaces.json");
  writeFileSync(projectsFile, "[]");
  writeFileSync(workspacesFile, "[]");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
const PROJECTS = ${JSON.stringify(projectsFile)};
const WORKSPACES = ${JSON.stringify(workspacesFile)};
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; } }
function write(file, value) { fs.writeFileSync(file, JSON.stringify(value)); }
function out(value) { console.log(JSON.stringify(value)); }
if (argv[0] === 'project' && argv[1] === 'ls') {
  out(read(PROJECTS));
} else if (argv[0] === 'project' && argv[1] === 'create') {
  const target = path.resolve(argv[2] || process.cwd());
  const rows = read(PROJECTS);
  let row = rows.find((entry) => entry.path === target);
  if (!row) {
    row = { projectId: 'proj_' + (rows.length + 1), name: path.basename(target), kind: 'git', path: target };
    rows.push(row);
    write(PROJECTS, rows);
  }
  out(row);
} else if (argv[0] === 'workspace' && argv[1] === 'ls') {
  out(read(WORKSPACES));
} else if (argv[0] === 'workspace' && argv[1] === 'create') {
  const target = argv[argv.indexOf('--path') + 1];
  const isolation = argv[argv.indexOf('--isolation') + 1];
  const title = argv[argv.indexOf('--title') + 1] || 'main';
  const rows = read(WORKSPACES);
  let row = rows.find((entry) => entry.cwd === target && entry.isolation === isolation);
  if (!row) {
    row = { workspaceId: 'wks_' + (rows.length + 1), project: path.basename(target), name: title, isolation, cwd: target, background: false };
    rows.push(row);
    write(WORKSPACES, rows);
  }
  out(row);
} else {
  out([]);
}
`);
  chmodSync(fake, 0o755);

  const config = join(TMP, "config.json");
  process.env.PASEO_BIN = fake;
  process.env.PASEO_STEWARD_CONFIG = config;
  const server = require(SERVER);

  const lines = () => (existsSync(argvLog) ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  const resetLog = () => writeFileSync(argvLog, "");

  // (a) A virgin folder: seven gates, one repo, one registration.
  const virgin = join(TMP, "virgin");
  mkdirSync(virgin, { recursive: true });
  const first = await server.controlSteward({ action: "onboard", project: virgin });

  check("a virgin folder returns all seven gates", Array.isArray(first.gates) && first.gates.length === 7,
    (first.gates ?? []).map((gate) => gate.id).join(", "));
  check("the gates are the seven named by the task",
    JSON.stringify((first.gates ?? []).map((gate) => gate.id)) ===
      JSON.stringify(["files", "git", "paseo_project", "workspace", "acceptance", "resume", "plan_fields"]),
    (first.gates ?? []).map((gate) => gate.id).join(", "));

  const created = filesUnder(virgin);
  for (const [path, text] of created) {
    check(`${path} was created with content`, typeof text === "string" && text.trim().length > 0,
      text === null ? "missing" : `${text.length} chars`);
  }
  const planText = created.find(([path]) => path === "plan.md")?.[1] ?? "";
  check("plan.md states the owner must supply 目标/基线/验收/约束",
    /TODO\(owner\).*目标 \/ 基线 \/ 验收 \/ 约束/s.test(planText),
    /TODO\(owner\)/.test(planText) ? "TODO marker present" : "no TODO marker");

  check("a virgin folder is a git repository with exactly one commit", git(virgin, "rev-list", "--count", "HEAD") === "1",
    git(virgin, "rev-list", "--count", "HEAD"));
  check("the repository is on main", git(virgin, "branch", "--show-current") === "main", git(virgin, "branch", "--show-current"));
  check("the first project was registered", first.projectId === "proj_1", first.projectId);
  check("the main local workspace was created", first.workspaceId === "wks_1", first.workspaceId);

  const configAfterFirst = JSON.parse(readFileSync(config, "utf8"));
  const row = configAfterFirst.projects.find((entry) => entry.root === virgin) ?? {};
  check("the config captures both ids", row.paseoProject === "proj_1" && row.workspace === "wks_1",
    `paseoProject=${row.paseoProject ?? "-"} workspace=${row.workspace ?? "-"}`);

  const byId = Object.fromEntries((first.gates ?? []).map((gate) => [gate.id, gate]));
  check("files, git, paseo project, workspace, RESUME and the four plan fields pass",
    ["files", "git", "paseo_project", "workspace", "resume", "plan_fields"].every((id) => byId[id]?.pass === true),
    Object.entries(byId).filter(([, gate]) => !gate.pass).map(([id]) => id).join(", ") || "all pass");
  check("the acceptance gate fails while plan.md is a TODO", byId.acceptance?.pass === false, byId.acceptance?.detail);
  check("the report does not claim success while a gate fails", first.success === false && first.ok === false,
    `success=${first.success} ok=${first.ok}`);

  // (b) Running twice is idempotent: no new commit, no re-registration, no rewrite.
  const beforeCommit = git(virgin, "rev-parse", "HEAD");
  const beforeFiles = filesUnder(virgin);
  resetLog();
  const second = await server.controlSteward({ action: "onboard", project: virgin });
  const secondArgv = lines();
  const beforeCommitAgain = git(virgin, "rev-parse", "HEAD");
  const afterFiles = filesUnder(virgin);

  check("the second run adds no commit and does not re-init git", beforeCommit === beforeCommitAgain,
    `${beforeCommit.slice(0, 8)} -> ${beforeCommitAgain.slice(0, 8)}`);
  check("the second run creates no Paseo project", !secondArgv.some((args) => args[0] === "project" && args[1] === "create"),
    `calls: ${secondArgv.map((args) => args.slice(0, 2).join(" ")).join(", ") || "none"}`);
  check("the second run creates no Paseo workspace", !secondArgv.some((args) => args[0] === "workspace" && args[1] === "create"),
    `calls: ${secondArgv.map((args) => args.slice(0, 2).join(" ")).join(", ") || "none"}`);
  check("the second run leaves every file unchanged",
    JSON.stringify(beforeFiles) === JSON.stringify(afterFiles),
    JSON.stringify(beforeFiles) === JSON.stringify(afterFiles) ? "byte-identical" : "content differs");
  check("the second run reports the same ids", second.projectId === first.projectId && second.workspaceId === first.workspaceId,
    `${second.projectId} / ${second.workspaceId}`);

  // The owner supplies a runnable acceptance command: the report can now be all green.
  const planPath = join(virgin, "plan.md");
  writeFileSync(planPath, readFileSync(planPath, "utf8").replace(
    "TODO(owner): a command that exits 0 only when the goal is met.",
    'node -e "process.exit(0)"',
  ));
  const complete = await server.controlSteward({ action: "onboard", project: virgin });
  check("a runnable owner acceptance turns all seven gates green", complete.success === true && complete.ok === true,
    complete.message);

  // (c) A folder that already has its own commit history is refused before any write.
  const existing = join(TMP, "existing");
  mkdirSync(existing, { recursive: true });
  git(existing, "init", "-b", "main");
  git(existing, "config", "user.email", "leg19@example.invalid");
  git(existing, "config", "user.name", "leg19");
  writeFileSync(join(existing, "notes.txt"), "owner history\n");
  git(existing, "add", "-A");
  git(existing, "commit", "-m", "owner's own commit");
  resetLog();
  const refused = await server.controlSteward({ action: "onboard", project: existing });

  check("a folder with an existing repository is refused", refused.ok === false && refused.success === false,
    `ok=${refused.ok} success=${refused.success}`);
  check("the refusal says why and mentions the existing history",
    /already has a git repository/.test(refused.message) && /1 commit/.test(refused.message), refused.message);
  check("the refusal writes no onboarding file", !existsSync(join(existing, "README.md")) && !existsSync(join(existing, "control")),
    existsSync(join(existing, "README.md")) || existsSync(join(existing, "control")) ? "README.md or control/ exists" : "no onboarding files");
  check("the refusal still reports the seven gates", Array.isArray(refused.gates) && refused.gates.length === 7,
    `${(refused.gates ?? []).length} gates`);

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check crashed:", error);
  process.exit(2);
});
