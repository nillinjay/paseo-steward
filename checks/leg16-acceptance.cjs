#!/usr/bin/env node
"use strict";

// Acceptance consumes aggregate evidence and proposes a row without writing to the project.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const { join, resolve, relative } = require("node:path");

const repo = resolve(__dirname, "..");
const tmp = fs.mkdtempSync("/tmp/leg16-");
const root = join(tmp, "project");
const task = "T-109";
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

function treeHash() {
  const hash = createHash("sha256");
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (fs.statSync(path).isDirectory()) walk(path);
      else {
        hash.update(JSON.stringify(relative(root, path)));
        hash.update("\0");
        hash.update(fs.readFileSync(path));
        hash.update("\0");
      }
    }
  }
  walk(root);
  return hash.digest("hex");
}

async function main() {
  execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + join(tmp, "server.cjs"), "--external:@getpaseo/*",
  ], { cwd: repo, stdio: "ignore" });
  process.env.NODE_PATH = join(repo, "node_modules");
  require("node:module")._initPaths();
  process.env.PASEO_STEWARD_CONFIG = join(tmp, "config.json");
  fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG, JSON.stringify({ projects: [], audit: [] }));
  process.env.PASEO_BIN = join(tmp, "paseo");
  fs.writeFileSync(process.env.PASEO_BIN, "#!/bin/sh\nprintf '[]\\n'\n");
  fs.chmodSync(process.env.PASEO_BIN, 0o755);

  fs.mkdirSync(join(root, "control"), { recursive: true });
  fs.mkdirSync(join(root, "checks/tasks"), { recursive: true });
  fs.mkdirSync(join(root, "checks/out"), { recursive: true });
  fs.writeFileSync(join(root, "control/COMMAND.md"),
    "# COMMAND\n\n## Dispatch ledger\n\n| leg | status | agent | note |\n|---|---|---|---|\n");
  fs.writeFileSync(join(root, "checks/tasks", task + ".json"), JSON.stringify({ id: task }));
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=leg16", "-c", "user.email=leg16@example.invalid", "commit", "-qm", "acceptance fixture");
  const head = git("rev-parse", "HEAD");
  // A second real commit supplies the mismatch fixture.
  git("-c", "user.name=leg16", "-c", "user.email=leg16@example.invalid", "commit", "--allow-empty", "-qm", "second fixture");
  const other = git("rev-parse", "HEAD");
  const server = require(join(tmp, "server.cjs"));
  const artifactPath = (sha) => join(root, "checks/out", task + "-" + sha + ".json");
  const record = (commit = head, extra = {}) => ({
    task, commit, verdict: "PASS", scope: { pass: true },
    provenance: { clean: true, commit },
    gate: { pass: true, commands: [{ cmd: "true", exit_code: 0 }] }, ...extra,
  });
  const write = (value) => fs.writeFileSync(artifactPath(value.commit), JSON.stringify(value));
  async function check(label, commit, ok, ready = false, expectedStatus) {
    const before = treeHash();
    const result = await server.controlSteward({ action: "accept", project: root, task, commit });
    assert.equal(result.ok, ok, label + ": " + result.message);
    const state = await server.readSteward({ project: root });
    const row = state.acceptance.find((entry) => entry.task === task);
    assert.equal(row.allCommandsPassed, ready, label + ": readiness");
    if (expectedStatus) assert.equal(row.status, expectedStatus, label + ": status");
    assert.equal(treeHash(), before, label + ": supervised files changed");
    console.log("PASS " + label + "; accept/read tree hash unchanged");
    return result;
  }

  await check("missing artifact refused", head, false);
  write(record(other));
  await check("sha mismatch refused", head, false, true);
  fs.unlinkSync(artifactPath(other));
  write(record(head, { gate: { pass: true, commands: [{ cmd: "false", exit_code: 1 }] } }));
  await check("non-zero command refused", head, false);
  write(record(head, { verdict: "FAIL" }));
  await check("FAIL verdict refused despite zero command exit", head, false);
  write(record(head, { gate: { pass: false, commands: [{ cmd: "true", exit_code: 0 }] } }));
  await check("aggregate gate false refused", head, false);
  write(record(head, { scope: { pass: false } }));
  await check("aggregate scope false refused", head, false);
  fs.unlinkSync(artifactPath(head));

  // Obtain an actual commit id from an independent repository, absent from the supervised one.
  const foreign = join(tmp, "foreign");
  fs.mkdirSync(foreign);
  execFileSync("git", ["init", "-q"], { cwd: foreign });
  execFileSync("git", ["-c", "user.name=foreign", "-c", "user.email=foreign@example.invalid",
    "commit", "--allow-empty", "-qm", "foreign commit"], { cwd: foreign });
  const absent = execFileSync("git", ["rev-parse", "HEAD"], { cwd: foreign, encoding: "utf8" }).trim();
  write(record(absent));
  await check("commit absent from repository refused", absent, false);
  fs.unlinkSync(artifactPath(absent));

  write(record(other, { provenance: undefined }));
  await check("missing clean-tree provenance refused", other, false, false, "legacy-artifact");
  write(record(head, { generated_at: "2030-01-01T00:00:00Z" }));
  write(record(other, { verdict: "FAIL", generated_at: "2020-01-01T00:00:00Z" }));
  // A -> B -> C: evidence for A passes, later evidence for B fails, no evidence for C.
  git("-c", "user.name=leg16", "-c", "user.email=leg16@example.invalid", "commit", "--allow-empty", "-qm", "third fixture");
  await check("later FAIL supersedes older PASS", head, false, false, "failed");
  const latest = (await server.readSteward({ project: root })).acceptance.find(entry => entry.task === task);
  assert.equal(latest.sha, other, "latest evidence is B despite A's newer timestamp");
  await check("latest FAIL cannot be accepted", other, false, false, "failed");
  fs.unlinkSync(artifactPath(head));

  write(record(other));
  const result = await check("valid PASS aggregate accepted", other, true, true);
  assert.equal(result.targetPath, join(root, "control/COMMAND.md"));
  assert.equal(result.proposedRow, result.message);
  assert.ok(result.proposedRow.includes(relative(root, artifactPath(other))));
  assert.ok(result.proposedRow.includes(other));
  assert.match(result.proposedRow, /accepted by gate, review pending/);
  assert.equal((await server.readSteward({ project: root })).acceptance[0].commitMatchesHead, true);
  assert.ok(!fs.readFileSync(join(root, "control/COMMAND.md"), "utf8").includes("accepted by gate"));
  console.log("PASS proposed row text and target path returned; acceptance remains distinct from review");
  console.log("OK");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
