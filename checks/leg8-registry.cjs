#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { resolve, join } = require("node:path");
const { skip, missingLedger, headCommit } = require("./preconditions.cjs");
const root = resolve(__dirname, "..");
// Every registration is matched against plan.md and every base against this repository's history.
const missingPlan = missingLedger("plan.md", root);
if (missingPlan) skip(`${missingPlan}; there are no registrations to match legs.json against`);
if (!headCommit(root)) skip("the tree under test has no commit; legs.json bases cannot resolve");
const registry = JSON.parse(readFileSync(join(__dirname, "legs.json"), "utf8"));
const plan = readFileSync(join(root, "plan.md"), "utf8");
assert.equal(new Set(registry.map((entry) => entry.id)).size, registry.length, "duplicate leg ids");
for (const id of ["leg7", "leg8", "leg8-negative-control"]) {
  assert.ok(registry.some((entry) => entry.id === id), `missing ${id}`);
}
for (const entry of registry) {
  assert.equal(typeof entry.title, "string");
  assert.ok(entry.title.length > 0);
  execFileSync("git", ["rev-parse", "--verify", `${entry.base}^{commit}`], { cwd: root, stdio: "pipe" });
  assert.ok(entry.commands.length > 0);
  for (const { cmd, timeoutSeconds } of entry.commands) {
    assert.equal(typeof cmd, "string");
    assert.ok(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0);
    assert.doesNotMatch(cmd, /\breload\b/i, "declared commands must not reload the plugin");
  }
  assert.ok(entry.writeSet.length > 0);
  assert.ok(entry.writeSet.every((glob) => typeof glob === "string" && glob.length > 0));
  if (entry.id.endsWith("-negative-control")) continue;
  const number = entry.id.slice(3);
  const heading = new RegExp(`^## LEG ${number} REGISTERED[^\\n]*$`, "m");
  const headingMatch = plan.match(heading);
  assert.ok(headingMatch, `${entry.id}: missing pre-declared registration`);
  const section = plan.slice(headingMatch.index + headingMatch[0].length).split(/^## /m)[0];
  const declared = section.split("**Pre-declared criteria.**")[1];
  assert.ok(declared, `${entry.id}: missing pre-declared criteria`);
  const criteriaText = declared.split(/\n\n\*\*(?!C\d)/)[0].trim();
  // Match whole multiline bullets; do not normalize their wording or whitespace.
  const bullets = criteriaText.split(/\n(?=- \*\*C\d+\*\* )/).map((bullet) => {
    const match = bullet.match(/^- \*\*(C\d+)\*\* ([\s\S]+)$/);
    assert.ok(match, `${entry.id}: unsupported criterion bullet`);
    return { code: match[1], text: match[2] };
  });
  assert.ok(bullets.length > 0);
  assert.deepEqual(entry.criteria, bullets, `${entry.id}: criteria must be copied verbatim from plan.md`);
  console.log(`PASS ${entry.id}: all ${bullets.length} criteria match plan.md verbatim; no reload command`);
}
const negative = registry.find((entry) => entry.id === "leg8-negative-control");
assert.deepEqual(negative.commands.map((entry) => entry.cmd), ['node -e "process.exit(3)"']);
const paseo = JSON.parse(readFileSync(join(root, "paseo.json"), "utf8"));
assert.equal(paseo.scripts.accept, "node checks/accept.cjs");
console.log("PASS mandatory exit-3 control and Paseo accept script are declared");
