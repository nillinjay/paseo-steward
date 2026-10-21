#!/usr/bin/env node
"use strict";

// Exercise the real CLI in an isolated repository. Never edit the real registry or HEAD.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const root = mkdtempSync(join(tmpdir(), "leg8-runner-"));
function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function run(id) {
  const env = { ...process.env };
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  return spawnSync(process.execPath, [join(root, "checks/accept.cjs"), id], {
    cwd: tmpdir(), encoding: "utf8", timeout: 15000, env,
  });
}
function artifact(id, sha) {
  return JSON.parse(readFileSync(join(root, "checks/out", `${id}-${sha}.json`), "utf8"));
}
function check(name, fn) { fn(); console.log(`PASS ${name}`); }

try {
  mkdirSync(join(root, "checks"));
  copyFileSync(join(__dirname, "accept.cjs"), join(root, "checks/accept.cjs"));
  git("init", "--quiet");
  git("config", "user.email", "leg8@example.invalid");
  git("config", "user.name", "LEG 8 fixture");
  git("add", "checks/accept.cjs");
  git("commit", "--quiet", "-m", "fixture base");
  // Accept certifies a clean tree. The artifacts this fixture writes are test output, not work, so exclude them
  // the way a repository would exclude build output; otherwise every run after the first looks dirty.
  writeFileSync(join(root, ".git", "info", "exclude"), "checks/out/\n");
  const base = git("rev-parse", "HEAD");
  const entry = (id, commands) => ({ id, title: id, base, commands,
    writeSet: ["checks/**"], criteria: [{ code: "fixture", text: "Fixture only" }] });
  const command = (cmd, timeoutSeconds = 5) => ({ cmd, timeoutSeconds });
  const registry = [
    entry("success", [command("node -e 'for(let n=0;n<60;n++) console.log(n); console.error(\"stderr captured\")'")]),
    entry("failure", [command('node -e "process.exit(3)"'), command('node -e "console.log(42)"')]),
    entry("timeout", [command("node -e 'setTimeout(()=>require(\"node:fs\").writeFileSync(\"orphan.txt\",\"bad\"),1500)'", 0.15)]),
    entry("signal", [command("kill -TERM $$")]),
    entry("bad-base", [command("node -e 'process.exit(0)'")]),
  ];
  registry.find((row) => row.id === "bad-base").base = "missing-ref";
  writeFileSync(join(root, "checks/legs.json"), JSON.stringify(registry));
  git("add", "checks/legs.json");
  git("commit", "--quiet", "-m", "fixture registry");
  const sha = git("rev-parse", "HEAD");

  check("unknown id exits 2 without an artifact", () => {
    const result = run("unknown");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown leg id: unknown/);
  });
  check("success binds runtime HEAD, UTC date, base diff, declared scope and last 40 lines", () => {
    const before = execFileSync("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"], { encoding: "utf8" }).trim();
    const result = run("success");
    const after = execFileSync("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"], { encoding: "utf8" }).trim();
    assert.equal(result.status, 0, `${result.stderr || ""}${result.stdout || ""}`);
    assert.equal(result.stdout.trim(), `checks/out/success-${sha}.json`);
    const data = artifact("success", sha);
    assert.equal(data.leg, "success");
    assert.equal(data.sha, sha);
    assert.match(data.startedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(data.startedAt >= before && data.startedAt <= after);
    // The producer writes PASS/FAIL. "accepted" belonged to the old acceptance path, which review N3 removed:
    // acceptance is a separate act that requires this verdict, not something the runner names itself.
    assert.equal(data.verdict, "PASS");
    assert.deepEqual(data.writeSet, ["checks/**"]);
    assert.equal(data.base, base);
    assert.deepEqual(data.changedFiles, ["checks/legs.json"]);
    assert.equal(data.commands[0].exitCode, 0);
    assert.ok(data.commands[0].durationMs >= 0);
    assert.equal(data.commands[0].outputTail.split("\n").length, 40);
    assert.match(data.commands[0].outputTail, /59/);
    assert.match(data.commands[0].outputTail, /stderr captured/);
    assert.doesNotMatch(data.commands[0].outputTail, /^0\n/);
  });
  check("exit 3 rejects, exits 1, and still runs subsequent commands", () => {
    assert.equal(run("failure").status, 1);
    const data = artifact("failure", sha);
    assert.equal(data.verdict, "FAIL");
    // The fixture excludes checks/out/ so the tree is clean and the commands run; the dirty-tree refusal is
    // pinned by the leg that introduced it (review 3, F3).
    assert.deepEqual(data.commands.map((row) => row.exitCode), [3, 0]);
    assert.equal(data.commands[1].outputTail, "42");
    assert.equal(data.verdict, "FAIL");
  });
  check("timeout rejects and kills shell descendants", () => {
    assert.equal(run("timeout").status, 1);
    const data = artifact("timeout", sha);
    assert.equal(data.verdict, "FAIL");
    assert.equal(data.commands[0].exitCode, 124);
    assert.equal(data.commands[0].timedOut, true);
    assert.ok(data.commands[0].durationMs < 3000);
    // Wait only in the fixture, long enough that an orphan would have written its marker.
    execFileSync(process.execPath, ["-e", "setTimeout(()=>{},1700)"]);
    assert.ok(!readdirSync(root).includes("orphan.txt"));
  });
  check("signal termination never counts as exit 0", () => {
    assert.equal(run("signal").status, 1);
    assert.equal(artifact("signal", sha).verdict, "FAIL");
  });
  check("invalid base fails without fabricating evidence", () => {
    const result = run("bad-base");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Acceptance runner failed/);
    assert.ok(!readdirSync(join(root, "checks/out")).some((name) => name.startsWith("bad-base-")));
  });
  check("a new commit gets a new artifact filename and runtime SHA", () => {
    writeFileSync(join(root, "checks/new.txt"), "new commit\n");
    git("add", "checks/new.txt");
    git("commit", "--quiet", "-m", "fixture next");
    const next = git("rev-parse", "HEAD");
    assert.equal(run("success").status, 0);
    assert.equal(artifact("success", next).sha, next);
    assert.ok(artifact("success", next).changedFiles.includes("checks/new.txt"));
    assert.equal(artifact("success", sha).sha, sha);
  });
  console.log("OK — 7 runner checks; all repository mutations confined to a temporary fixture");
} finally {
  rmSync(root, { recursive: true, force: true });
}
