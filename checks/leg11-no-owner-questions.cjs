#!/usr/bin/env node
/**
 * LEG 11 acceptance — a worker must not stop to ask the owner.
 *
 * Measured failure: a worker ended its turn with a question for the owner, and the same patch was applied
 * by hand several times. The four owner-only classes now travel inside every brief, the deny message says
 * what to do instead, and a BLOCKED report that names no class is rejected as a failed decision rather
 * than counted as a wait.
 */
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { skipPart, missingLedger } = require("./preconditions.cjs");

const REPO = join(__dirname, "..");
const BUNDLE = "/tmp/steward-leg11-server.cjs";

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function main() {
  // Sections 1-7 read the plugin and the worker-brief template; only section 8 needs this project's ledger.
  const missingCommand = missingLedger("control/COMMAND.md", REPO);
  if (missingCommand) skipPart(`${missingCommand}; section 8 (the protocol page states the rule) not run`);

  execFileSync("npx", [
    "esbuild", "server/steward.ts", "--bundle", "--platform=node", "--format=cjs",
    "--outfile=" + BUNDLE, "--external:@getpaseo/*",
  ], { cwd: REPO, stdio: "ignore" });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const server = require(BUNDLE);
  const classes = server.OWNER_ONLY_CLASSES;
  const rule = server.OWNER_ONLY_RULE;

  // 1. The four classes exist and the rule is the exact sentence briefs must end with.
  check("four owner-only classes are defined", classes.length === 4, `${classes.length} class(es)`);
  check("the rule names the four-class boundary", /one of these four/i.test(rule));

  // 2. The steward's own dispatch brief carries all four verbatim and ends with the rule.
  for (const cls of classes) {
    check(`dispatch brief carries "${cls}"`, server.RESUME_PROMPT.includes(cls));
  }
  check("dispatch brief ends with the decision rule", server.RESUME_PROMPT.trim().endsWith(rule));

  // 3. The canonical worker brief carries them verbatim and ends with the rule.
  const brief = readFileSync(join(REPO, "docs/templates/worker-brief.md"), "utf8");
  for (const cls of classes) {
    check(`worker brief carries "${cls}"`, brief.includes(cls));
  }
  check("worker brief ends with the decision rule", brief.trim().endsWith(rule));

  // 4. A question denied by policy is told what to do instead, in one sentence.
  const deny = server.QUESTION_DENY_MESSAGE;
  for (const cls of classes) {
    check(`deny message carries "${cls}"`, deny.includes(cls));
  }
  check("deny message carries the decision instruction",
    deny.includes("decide it yourself, record the decision in your report, and keep going"));
  check("deny message is one sentence", (deny.match(/[.!?](\s|$)/g) ?? []).length === 1,
    `${(deny.match(/[.!?](\s|$)/g) ?? []).length} sentence end(s)`);

  // 5. The parser rejects a BLOCKED report that names no class.
  const noClass = server.parseWorkerReport([
    "status: BLOCKED",
    "commit_sha: -",
    "artifact_path: -",
    "error: error_code=E_STOPPED; first_root_cause=worker asked the owner; log_path=/tmp/worker.log",
  ].join("\n"));
  check("BLOCKED with no owner-only class is rejected", noClass.ok === false,
    noClass.ok ? "accepted" : noClass.reason);

  // 6. A BLOCKED report that names a class is accepted and counted as waiting on owner.
  const withClass = server.parseWorkerReport([
    "status: BLOCKED",
    `blocked_on: ${classes[1]}`,
    "commit_sha: -",
    "artifact_path: -",
    "error: error_code=E_MEANING; first_root_cause=criterion ambiguous; log_path=/tmp/worker.log",
  ].join("\n"));
  check("BLOCKED naming a class is accepted", withClass.ok === true,
    withClass.ok ? "" : withClass.reason);
  check("a named BLOCKED report increments waiting on owner",
    withClass.ok === true && withClass.report.waitingOnOwner === true &&
      withClass.report.blockedOn === classes[1] && withClass.report.decisionFailure === false);

  // 7. DONE needs no class and never counts as waiting.
  const done = server.parseWorkerReport([
    "status: DONE",
    "commit_sha: " + "a".repeat(40),
    "artifact_path: checks/out/example.json",
    "error: -",
  ].join("\n"));
  check("DONE needs no class", done.ok === true && done.report.waitingOnOwner === false &&
    done.report.decisionFailure === false);

  // 8. The protocol page states the same rule, so a successor reads it.
  if (!missingCommand) {
    const command = readFileSync(join(REPO, "control/COMMAND.md"), "utf8");
    for (const cls of classes) {
      check(`COMMAND.md carries "${cls}"`, command.includes(cls));
    }
    check("COMMAND.md says a BLOCKED report must name a class",
      /blocked_on=<one of the four>/.test(command));
    check('COMMAND.md keeps the "waiting on owner" counter named-waits-only',
      /waiting on owner/i.test(command) && /decision the worker failed to make/i.test(command));
  }

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
