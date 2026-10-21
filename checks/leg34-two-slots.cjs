#!/usr/bin/env node
/**
 * LEG 34 — two implementation slots, counted by one pure function.
 *
 * V1.1 runs two implementation legs at the same time. The slot arithmetic must be the same wherever it
 * is asked: the surface, the warning and the capitalist poke. These checks call the exported pure
 * functions directly; they do not parse module internals.
 */
const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const REPO = path.resolve(__dirname, "..");
const TMP = mkdtempSync(path.join(os.tmpdir(), "steward-leg34-"));
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

function main() {
  const bundle = path.join(TMP, "steward.cjs");
  execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--external:@getpaseo/*", "--outfile=" + bundle,
  ], { cwd: REPO, stdio: "ignore" });
  process.env.NODE_PATH = path.join(REPO, "node_modules");
  require("node:module")._initPaths();
  process.env.PASEO_STEWARD_CONFIG = path.join(TMP, "config.json");
  process.env.PASEO_BIN = "/bin/false";

  const { implementationSlotsFree, capitalistMessage } = require(bundle);
  assert.equal(typeof implementationSlotsFree, "function", "implementationSlotsFree must be exported");
  assert.equal(typeof capitalistMessage, "function", "capitalistMessage must be exported");

  const workspace = (id, isolation = "worktree") => ({
    project: "demo", id, name: id, isolation, cwd: `/tmp/demo-${id}`, stewardLike: false,
  });
  const free = (own) => implementationSlotsFree(own, { workers: [] }, 2);

  check("two worktrees leave 0 of 2 implementation slots free", () => {
    const slots = free([workspace("wt-a"), workspace("wt-b")]);
    assert.equal(slots.free, 0, `free=${slots.free}`);
    assert.equal(slots.cap, 2, `cap=${slots.cap}`);
  });
  check("one worktree leaves 1 of 2 implementation slots free", () => {
    const slots = free([workspace("wt-a")]);
    assert.equal(slots.free, 1, `free=${slots.free}`);
    assert.equal(slots.cap, 2, `cap=${slots.cap}`);
  });
  check("no worktree leaves 2 of 2 implementation slots free", () => {
    const slots = free([workspace("main", "local")]);
    assert.equal(slots.free, 2, `free=${slots.free}`);
    assert.equal(slots.cap, 2, `cap=${slots.cap}`);
  });
  check("a main-workspace worker costs a slot even with no worktree", () => {
    const worker = { id: "w1", name: "T-1 worker", provider: "p", cwd: "/tmp/demo-main", workspaceId: "main" };
    const slots = implementationSlotsFree([workspace("main", "local")], { workers: [worker] }, 2);
    assert.equal(slots.free, 1, `free=${slots.free}`);
  });

  const message = capitalistMessage({
    free: 2, cap: 2, queueLength: 3,
    chosen: { label: "T-next", priority: "P0", cancelHow: "never" },
    ineligibleP1: [],
    juniorProvider: "opencode/cheap-junior",
  });
  check("the poke tells the steward to fill BOTH free slots in one turn", () => {
    assert.match(message, /2\/2/, "the idle count is in the poke");
    assert.match(message, /一次填满/, "one turn must fill all free slots");
    assert.match(message, /同一轮/, "the legs are dispatched in the same turn");
    assert.match(message, /2 条实现腿/, "the poke names both legs");
  });
  check("the poke still names the chosen row and the cheap tier", () => {
    assert.match(message, /T-next/);
    assert.match(message, /opencode\/cheap-junior/);
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
