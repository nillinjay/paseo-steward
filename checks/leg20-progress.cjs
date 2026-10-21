#!/usr/bin/env node
// T-116: deterministic checks over the pure calculation; no daemon or project writes.
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { buildSync } = require("esbuild");

const temp = mkdtempSync(join(tmpdir(), "leg20-progress-"));
let passed = 0;
try {
  const bundle = join(temp, "progress.cjs");
  buildSync({ entryPoints: [join(__dirname, "../shared/progress.ts")], bundle: true, platform: "node", format: "cjs", outfile: bundle, logLevel: "silent" });
  const { computeProgress, ProgressSnapshotSchema, progressGet } = require(bundle);
  const input = (extra = {}) => ({ planText: "", tasks: [], readyQueue: [], worktrees: [], ownerQuestions: [], ...extra });
  const plan = "# Project\n## Milestones\n- [x] M1 First\n- [x] M2 Second\n- [x] M3 Third\n- [ ] M4 Fourth\n- [ ] M5 Fifth\n## Backlog\n- [x] M6 Outside the milestones section\n";
  function check(name, test) {
    test();
    passed++;
    console.log(`PASS ${name}`);
  }
  check("3 of 5 milestones = 60.0%, with an explicit basis", () => {
    const result = computeProgress(input({ planText: plan }));
    assert.equal(result.percent, 60.0);
    assert.equal(result.basis, "milestones");
    assert.equal(result.estimated, false);
    assert.deepEqual(result.milestones, { done: 3, total: 5 });
  });
  check("no milestones: accepted registry legs plus the Ready queue form the estimate", () => {
    const result = computeProgress(input({ tasks: [{ id: "T-1", acceptedAt: "2026-10-20T00:00:00Z" }, { id: "T-2", status: "accepted" }], readyQueue: ["T-3"] }));
    assert.equal(result.basis, "legs");
    assert.equal(result.estimated, true);
    assert.equal(result.milestones, null);
    assert.equal(result.percent, 66.7);
    assert.deepEqual(result.legs, { accepted: 2, open: 1 });
  });
  check("empty project: 0%, nothing to measure, unknown age stays null", () => {
    const result = computeProgress();
    assert.equal(result.percent, 0);
    assert.match(result.label, /nothing to measure/i);
    assert.equal(result.attention.staleHours, null);
    assert.deepEqual(result.legs, { accepted: 0, open: 0 });
  });
  check("segments partition unique legs across all five states", () => {
    const result = computeProgress(input({
      tasks: [
        { id: "T-1", status: "accepted", lastOutcome: "BLOCKED" },
        { id: "T-2", status: "in_review" },
        { id: "T-3", lastOutcome: "DONE" },
        { id: "T-4" },
        { id: "T-5", lastOutcome: "BLOCKED" },
        { id: "T-6", lastOutcome: "FAILED" },
      ],
      readyQueue: ["**T-1**", "T-5", "T-7", "t-7"],
      worktrees: [{ taskId: "T-2" }, { taskId: "T-3" }, { taskId: "T-4" }, { taskId: "T-5" }, { taskId: "unknown" }],
    }));
    // T-6 (FAILED, not accepted, not open) is HISTORY: a manifest records a leg that was attempted, not a
    // backlog item. Counting it as "queued" is what made the queue grow with every review (owner, 2026-10-20).
    assert.deepEqual(result.segments, [
      { key: "accepted", count: 1 }, { key: "inReview", count: 2 }, { key: "inFlight", count: 1 },
      { key: "queued", count: 1 }, { key: "blocked", count: 1 },
    ]);
    assert.equal(result.segments.reduce((sum, segment) => sum + segment.count, 0), result.legs.accepted + result.legs.open);
    assert.equal(result.attention.blocked, 1);
  });
  check("a manifest that is neither accepted nor open does not enlarge the denominator", () => {
    const withHistory = computeProgress(input({
      tasks: [{ id: "T-1", acceptedAt: "2026-10-20" }, { id: "T-9", lastOutcome: "FAILED" }],
      readyQueue: ["T-2"],
    }));
    assert.equal(withHistory.legs.accepted + withHistory.legs.open, 2, "history must not count as queued");
    assert.equal(withHistory.percent, 50);
  });
  check("reopening a milestone reduces the percentage from 60 to 40", () => {
    assert.equal(computeProgress(input({ planText: plan })).percent, 60);
    assert.equal(computeProgress(input({ planText: plan.replace("[x] M2", "[ ] M2") })).percent, 40);
  });
  check("splitting a leg increases the denominator and reduces the estimate", () => {
    const before = input({ tasks: [{ id: "T-1", status: "accepted" }], readyQueue: ["T-2"] });
    assert.equal(computeProgress(before).percent, 50);
    assert.equal(computeProgress({ ...before, readyQueue: ["T-2", "T-3"] }).percent, 33.3);
  });
  check("milestone IDs count once, the latest checkbox wins, examples do not count", () => {
    const result = computeProgress(input({ planText: `${plan}\n## Milestones\n- [ ] M1 Reopened\n\x60\x60\x60md\n- [x] M99 Example\n\x60\x60\x60\n` }));
    assert.deepEqual(result.milestones, { done: 2, total: 5 });
    assert.equal(result.percent, 40);
  });
  check("the current outcome clears an old blocked status and accepted legs stay accepted", () => {
    const result = computeProgress(input({ tasks: [{ id: "T-1", status: "blocked", lastOutcome: "DONE" }], worktrees: [{ taskId: "T-1" }] }));
    assert.equal(result.attention.blocked, 0);
    assert.equal(result.segments.find((segment) => segment.key === "inReview").count, 1);
  });
  check("missing sources are disclosed and unknown age never becomes zero", () => {
    const result = computeProgress({ tasks: [{ id: "T-1" }], staleHours: NaN });
    assert.match(result.label, /unavailable:.*live worktrees/);
    assert.equal(result.attention.staleHours, null);
  });
  check("calculation leaves the input unchanged and returns a valid RPC snapshot", () => {
    const source = input({ planText: plan, ownerQuestions: ["Q1", "Q1", "Q2"], staleHours: 2.26 });
    const before = JSON.stringify(source);
    const result = computeProgress(source);
    assert.equal(JSON.stringify(source), before);
    assert.equal(result.attention.ownerQuestions, 2);
    assert.equal(result.attention.staleHours, 2.3);
    assert.equal(progressGet.name, "progress.get");
    ProgressSnapshotSchema.parse(result);
  });
  console.log(`T-116 progress: ${passed}/${passed} PASS`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
