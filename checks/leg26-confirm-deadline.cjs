#!/usr/bin/env node
/**
 * LEG 26 — a confirmation refresh that never settles must not hold the sweep.
 *
 * Review 6B (F6-1): the confirm callback awaited a refresh with no time bound. If that promise never
 * settled, the policy function never returned, the entry stayed in the in-flight map, and the sweep
 * loop never reached the next pending request.
 *
 * This check drives the real `answer-pending` sweep with a fake Paseo ref whose confirmation refresh
 * never settles. It asserts that each answer returns within the declared deadline, is audited as
 * `unconfirmed`, and that the second request in the same sweep is still processed.
 */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { build } = require("esbuild");

const root = path.resolve(__dirname, "..");
const configPath = "/leg26-fixture/config.json";
const project = "/leg26-fixture/project";
const agent = { id: "agent-123", title: "Fixture agent", cwd: project };

async function bundle(entry) {
  return (await build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: "node", format: "cjs",
    write: false, external: ["@getpaseo/*"],
  })).outputFiles[0].text;
}

function load(code, filename) {
  const m = new Module(filename);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(root);
  m._compile(code, filename);
  return m.exports;
}

/**
 * A fake Paseo ref: the authoritative snapshot refresh settles, but the refresh used for confirmation
 * never does. `respondToPermission` marks the next refresh as the confirmation call.
 */
function fixture(code, pendingRows) {
  const files = new Map([
    [configPath, JSON.stringify({ projects: [{
      root: project, workspace: "ws-1", intervalMinutes: 20, enabled: false,
      leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true, autoAllowShell: true,
    }], audit: [], auditEvictions: {} })],
    [`${project}/control/COMMAND.md`, "# Fixture\n"],
  ]);
  let pending = pendingRows.map((row) => ({ ...row, agentId: agent.id }));
  let hangNextRefresh = false;
  const responses = [];
  const fs = {
    existsSync: (p) => files.has(String(p)) || p === project,
    readFileSync(p) { if (!files.has(String(p))) throw new Error("ENOENT"); return files.get(String(p)); },
    writeFileSync(p, text) { files.set(String(p), String(text)); },
    renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
    unlinkSync(p) { files.delete(String(p)); },
    openSync() { return 123; }, fsyncSync() {}, closeSync() {},
  };
  const cp = { execFile(_bin, args, _opts, callback) {
    let value = [];
    if (args[0] === "workspace") value = [{ project: "project", workspaceId: "ws-1", cwd: project, isolation: "local", name: "Fixture" }];
    if (args[0] === "agent") value = [{ id: agent.id, name: agent.title, cwd: project, status: "idle" }];
    if (args[0] === "permit") value = pending.map((row) => ({ ...row }));
    callback(null, JSON.stringify(value), "");
  }};
  const m = new Module(path.join(root, "checks/leg26-fixture.cjs"));
  m.filename = path.join(root, "checks/leg26-fixture.cjs");
  m.paths = Module._nodeModulePaths(root);
  const nativeRequire = m.require.bind(m);
  m.require = (id) => id === "node:fs" ? fs : id === "node:child_process" ? cp : nativeRequire(id);
  m._compile(`(function(process) {\n${code}\n})({env: {PASEO_STEWARD_CONFIG: ${JSON.stringify(configPath)}}});`, m.filename);
  const ref = {
    cwd: project,
    get pendingPermissions() { return pending; },
    async refresh() {
      if (hangNextRefresh) {
        hangNextRefresh = false;
        return new Promise(() => {});
      }
      return { agent: { pendingPermissions: [...pending] } };
    },
    async respondToPermission({ requestId, response }) {
      responses.push({ requestId, response, at: Date.now() });
      pending = pending.filter((row) => row.id !== requestId);
      hangNextRefresh = true;
    },
  };
  const context = { paseo: { agents: { ref: () => ref } } };
  return {
    sweep: () => m.exports.controlSteward({ action: "answer-pending", project }, context),
    get responses() { return responses; },
    audit() { return JSON.parse(files.get(configPath)).audit; },
  };
}

function withGuard(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`sweep did not return within ${ms} ms`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function main() {
  const source = readFileSync(path.join(root, "server/steward.ts"), "utf8");
  const match = /const CONFIRM_DEADLINE_MS\s*=\s*([0-9_]+)\s*;/.exec(source);
  assert.ok(match, "server/steward.ts must declare a finite CONFIRM_DEADLINE_MS constant");
  const deadline = Number(match[1].replace(/_/g, ""));
  assert.ok(Number.isFinite(deadline) && deadline > 0, "the confirmation deadline must be finite and positive");

  const server = await bundle("server/steward.ts");
  const requests = [
    { id: "r1", name: "ExitPlanMode", kind: "plan", input: {} },
    { id: "r2", name: "ExitPlanMode", kind: "plan", input: {} },
  ];
  const fixtureUnderTest = fixture(server, requests);

  const started = Date.now();
  // Two answers, each confirmed by a refresh that never settles: a bounded fix returns after two
  // deadlines. Without the fix this promise never settles and the guard fails the check.
  const result = await withGuard(fixtureUnderTest.sweep(), deadline * 2 + 4_000);
  const elapsed = Date.now() - started;

  assert.equal(fixtureUnderTest.responses.length, 2, "the sweep must reach the second request");
  assert.deepEqual(fixtureUnderTest.responses.map((r) => r.requestId), ["r1", "r2"],
    "both requests in the same sweep must be answered, in order");
  const gap = fixtureUnderTest.responses[1].at - fixtureUnderTest.responses[0].at;
  assert.ok(gap <= deadline + 1_500, `the first confirmation must time out within ${deadline} ms (gap ${gap} ms)`);
  assert.ok(elapsed <= deadline * 2 + 1_500, `the sweep must return after at most two deadlines (took ${elapsed} ms)`);

  const rows = fixtureUnderTest.audit().filter((row) => row.requestId === "r1" || row.requestId === "r2");
  assert.equal(rows.length, 2, "both answers must be audited");
  for (const row of rows) {
    assert.equal(row.delivery, "unconfirmed", `request ${row.requestId} must be audited as unconfirmed`);
    assert.equal(row.ok, false, `request ${row.requestId} must not claim confirmation`);
  }
  assert.match(result.message, /unconfirmed/g, "the sweep result must report the unconfirmed delivery");
  assert.equal((result.message.match(/unconfirmed/g) ?? []).length, 2, "both answers must report unconfirmed");

  console.log(`PASS  leg26: confirmation is bounded at ${deadline} ms; both sweep requests audit unconfirmed`);
}

main().catch((error) => {
  console.error(`FAIL  leg26: ${error.message}`);
  process.exitCode = 1;
});
