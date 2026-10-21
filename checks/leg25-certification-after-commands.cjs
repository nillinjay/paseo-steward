#!/usr/bin/env node
"use strict";

// Exercise the real acceptance runner in an isolated repository. Certification must describe the tree it
// started with: commands that modify a file or move HEAD may not leave a PASS behind.
const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

const root = mkdtempSync(join(tmpdir(), "leg25-cert-"));
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

try {
  mkdirSync(join(root, "checks"));
  copyFileSync(join(__dirname, "accept.cjs"), join(root, "checks/accept.cjs"));
  git("init", "--quiet");
  git("config", "user.email", "leg25@example.invalid");
  git("config", "user.name", "LEG 25 fixture");
  writeFileSync(join(root, "tracked.txt"), "original\n");
  git("add", "checks/accept.cjs");
  git("add", "tracked.txt");
  git("commit", "--quiet", "-m", "fixture base");
  // Artifacts are test output, not work, so keep them out of the cleanliness check.
  writeFileSync(join(root, ".git", "info", "exclude"), "checks/out/\n");
  const base = git("rev-parse", "HEAD");
  const command = (cmd, timeoutSeconds = 5) => ({ cmd, timeoutSeconds });
  const entry = (id, commands) => ({ id, title: id, base, commands,
    writeSet: ["checks/**", "tracked.txt"], criteria: [{ code: "fixture", text: "Fixture only" }] });
  const registry = [
    entry("tree-changed", [
      command("node -e \"require('node:fs').appendFileSync('tracked.txt','modified during acceptance\\n')\""),
      command("node -e \"const t=require('node:fs').readFileSync('tracked.txt','utf8');if(!t.includes('modified during acceptance'))process.exit(1)\""),
    ]),
    entry("head-changed", [
      command("node -e \"const fs=require('node:fs'),cp=require('node:child_process');fs.writeFileSync('made-during-acceptance.txt','new\\n');cp.execFileSync('git',['add','made-during-acceptance.txt']);cp.execFileSync('git',['-c','user.name=LEG 25','-c','user.email=leg25@example.invalid','commit','--quiet','-m','commit made during acceptance'])\""),
    ]),
    entry("clean", [
      command("node -e \"console.log('first')\""),
      command("node -e \"console.log('second')\""),
    ]),
  ];
  writeFileSync(join(root, "checks/legs.json"), JSON.stringify(registry));
  git("add", "checks/legs.json");
  git("commit", "--quiet", "-m", "fixture registry");
  const sha = git("rev-parse", "HEAD");
  const reset = () => git("reset", "--hard", "--quiet", sha);

  reset();
  assert.equal(run("tree-changed").status, 1);
  const treeChanged = artifact("tree-changed", sha);
  assert.equal(treeChanged.verdict, "FAIL");
  assert.match(treeChanged.reason, /tree changed/i);
  assert.deepEqual(treeChanged.commands.map((row) => row.exitCode), [0, 0],
    "both commands succeed; only the post-command tree check rejects");
  console.log("PASS a command that modifies a tracked file yields FAIL, reason names the tree change");

  reset();
  assert.equal(run("head-changed").status, 1);
  const headChanged = artifact("head-changed", sha);
  assert.equal(headChanged.verdict, "FAIL");
  assert.equal(headChanged.sha, sha);
  assert.match(headChanged.reason, /HEAD changed/);
  assert.notEqual(git("rev-parse", "HEAD"), sha);
  console.log("PASS a command that creates a commit yields FAIL, reason names the HEAD change");

  reset();
  const clean = run("clean");
  assert.equal(clean.status, 0, `${clean.stderr || ""}${clean.stdout || ""}`);
  const cleanArtifact = artifact("clean", sha);
  assert.equal(cleanArtifact.verdict, "PASS");
  assert.equal(cleanArtifact.reason, null);
  assert.deepEqual(cleanArtifact.commands.map((row) => row.exitCode), [0, 0]);
  console.log("PASS a clean pair of commands still certifies");
} finally {
  rmSync(root, { recursive: true, force: true });
}
