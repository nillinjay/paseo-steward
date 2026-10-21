#!/usr/bin/env node
/**
 * LEG 15 acceptance — a stale RESUME.md is worse than none.
 *
 * A successor reads `control/RESUME.md` as CURRENT state and skips the rest of the tree. If commits
 * landed after its `更新时间：<ISO>` line, that one screen describes a tree that no longer exists — the
 * successor trusts a brief and repeats or contradicts work that is already done.
 *
 * This check builds a throwaway repo, commits a newer change over an old brief, and asserts the warning
 * appears in `readSteward`'s warnings and in the client's status detail. It then rewrites the timestamp
 * and asserts both go quiet. Nothing real is touched.
 */
const { execFileSync } = require("node:child_process");
const { chmodSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const SERVER = "/tmp/steward-leg15-server.cjs";
const CLIENT = "/tmp/steward-leg15-client.cjs";
const TMP = join(os.tmpdir(), `leg15-${process.pid}`);
const STEWARD = "aaaa1111-0000-4000-8000-000000000015";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function iso(minutesOffset) {
  return new Date(Date.now() + minutesOffset * 60_000).toISOString().slice(0, 16) + "Z";
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeResume(root, stamp) {
  mkdirSync(join(root, "control"), { recursive: true });
  writeFileSync(join(root, "control", "RESUME.md"), [
    "# RESUME — 总管交接单",
    "",
    `**更新时间：${stamp}**（谁改的：leg15 test）`,
    "",
    "## 一句话现状",
    "",
    "The brief a successor trusts.",
    "",
  ].join("\n"));
}

function writeCommand(root) {
  writeFileSync(join(root, "control", "COMMAND.md"), [
    "# COMMAND", "",
    "## Lease", "",
    "    session=pi:test",
    `    paseo-agent=${STEWARD}`,
    "    since=2026-10-20T00:00Z",
    `    heartbeat=${iso(0)}`,
    "    state=held",
    "", "## Dispatch ledger", "",
  ].join("\n"));
}

async function main() {
  execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + SERVER, "--external:@getpaseo/*",
  ], { cwd: REPO, stdio: "ignore" });
  execFileSync("npx", [
    "esbuild", "client/model.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + CLIENT,
  ], { cwd: REPO, stdio: "ignore" });

  mkdirSync(TMP, { recursive: true });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const fake = join(TMP, "fake-paseo");
  const agentsFile = join(TMP, "agents.json");
  const workspacesFile = join(TMP, "workspaces.json");
  writeFileSync(workspacesFile, "[]");
  writeFileSync(agentsFile, JSON.stringify([
    { id: STEWARD, name: "the steward", provider: "pi", cwd: join(TMP, "project"), status: "idle" },
  ]));
  writeFileSync(fake, `#!/bin/sh
case "$1 $2" in
  "agent ls") cat ${agentsFile};;
  "workspace ls") cat ${workspacesFile};;
  *) printf '[]\\n';;
esac
`);
  chmodSync(fake, 0o755);

  process.env.PASEO_BIN = fake;
  process.env.PASEO_STEWARD_CONFIG = join(TMP, "config.json");

  const root = join(TMP, "project");
  mkdirSync(join(root, "control"), { recursive: true });
  git(root, "init", "-q");
  git(root, "config", "user.email", "leg15@example.invalid");
  git(root, "config", "user.name", "leg15");

  // 1. An old brief, committed. A successor would read this and believe it.
  writeResume(root, "2020-01-01T00:00:00Z");
  writeCommand(root);
  writeFileSync(join(root, "work.txt"), "first\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "old brief");

  // 2. Something NEWER lands in the tree, and the brief is not touched. This is the stale state.
  writeFileSync(join(root, "work.txt"), "first\nsecond\n");
  git(root, "add", "work.txt");
  git(root, "commit", "-q", "-m", "work the brief never saw");

  const server = require(SERVER);
  const client = require(CLIENT);
  const stale = await server.readSteward({ project: root });
  const warning = (stale.warnings ?? []).find((w) => /RESUME\.md is older than the latest commit/.test(w));
  check("a commit newer than the 更新时间 line raises the stale-brief warning", Boolean(warning), warning ?? "no warning");
  check("the warning says a successor would trust a stale brief",
    /a successor would trust a stale brief/.test(warning ?? ""), warning ?? "no warning");
  check("the warning is not raised by a missing lease, a missing brief or a dirty file",
    (stale.warnings ?? []).filter((w) => /RESUME\.md is older/.test(w)).length === 1,
    `${(stale.warnings ?? []).filter((w) => /RESUME\.md is older/.test(w)).length} match(es)`);

  const statusStale = client.stewardStatus(stale);
  check("the client status detail carries the stale-brief warning while a lease exists",
    /RESUME\.md is older than the latest commit/.test(statusStale.detail), statusStale.detail);

  // 3. Rewrite the timestamp. Nothing else changes; the warning must disappear.
  writeResume(root, new Date().toISOString());
  const fresh = await server.readSteward({ project: root });
  check("updating 更新时间 clears the warning",
    !(fresh.warnings ?? []).some((w) => /RESUME\.md is older than the latest commit/.test(w)),
    (fresh.warnings ?? []).join(" | ") || "no warnings");
  const statusFresh = client.stewardStatus(fresh);
  check("the client status detail no longer repeats it",
    !/RESUME\.md is older than the latest commit/.test(statusFresh.detail), statusFresh.detail);

  // 4. An absent brief is unknown, never stale: this function must not invent a warning.
  rmSync(join(root, "control", "RESUME.md"));
  const absent = await server.readSteward({ project: root });
  check("no RESUME.md means no stale warning (absent is not stale)",
    !(absent.warnings ?? []).some((w) => /RESUME\.md is older/.test(w)),
    (absent.warnings ?? []).join(" | ") || "no warnings");

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check crashed:", error);
  process.exit(2);
});
