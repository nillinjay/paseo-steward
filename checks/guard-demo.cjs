#!/usr/bin/env node
/**
 * guard-demo — seven acceptance cases for checks/guard.cjs, on a throwaway git repo in /tmp.
 *
 *   1. an in-scope commit passes                  -> SCOPE_PASS, GATE_PASS, exit 0
 *   2. an out-of-scope commit fails               -> SCOPE_FAIL, exit 1
 *   3. a delete under contract_paths fails        -> SCOPE_FAIL, exit 1
 *   4. a failing acceptance command fails         -> SCOPE_PASS, GATE_FAIL, exit 1
 *   5. a shared-contract Manifest enters          -> SCOPE_PASS, GATE_PASS, exit 0
 *   6. a tracked edit on top of --commit fails    -> SCOPE_PASS, GATE_FAIL, exit 1
 *   7. a worktree HEAD different from --commit fails -> SCOPE_PASS, GATE_FAIL, exit 1
 *
 * The demo only reads the real guard and writes inside its own /tmp repo.
 */
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const GUARD = join(__dirname, "guard.cjs");
const ROOT = mkdtempSync(join(os.tmpdir(), "guard-demo-"));
let BASE = null;

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(relative, content) {
  const file = join(ROOT, relative);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, content, "utf8");
}

function manifest(task, base, acceptance) {
  // Exactly the shared contract's shape. `contract_paths` is an extra Gate 0 hint the schema strips;
  // it must not be what makes Guard accept or refuse the manifest.
  return {
    task_id: task,
    lane: "standard",
    tier: "junior",
    risk: "R2",
    brief_kind: "delivery",
    base,
    write_scope: ["src/"],
    contract_paths: ["src/contract.md"],
    forbidden: [".env", "*.lock", ".github/"],
    ops_actions: [],
    acceptance,
    expires_at: null,
    p0_or_p1: "P0",
    cancel_how: "not cancellable — evidence stays on the branch",
    reference: ["DESIGN-V2.md"],
  };
}

function runGuard(task, base, commit) {
  const result = spawnSync(
    process.execPath,
    [GUARD, "check", "--task", task, "--base", base, "--commit", commit, "--worktree", ROOT],
    { cwd: ROOT, encoding: "utf8" },
  );
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
    lines: result.stdout.trim().split("\n").filter(Boolean),
  };
}

function caseCommit(name, apply, paths) {
  git("checkout", "-q", "-B", name, BASE);
  apply();
  if (paths.length > 0) git("add", "--", ...paths);
  git("commit", "-qm", name);
  return git("rev-parse", "HEAD");
}

function main() {
  execFileSync("git", ["init", "-q"], { cwd: ROOT });
  git("config", "user.email", "guard-demo@example.invalid");
  git("config", "user.name", "guard demo");

  write("src/a.txt", "one\n");
  write("src/contract.md", "contract\n");
  write("README.md", "demo\n");
  git("add", "--", "src/a.txt", "src/contract.md", "README.md");
  git("commit", "-qm", "base content");
  const anchor = git("rev-parse", "HEAD");

  write(
    "checks/tasks/T-101.json",
    `${JSON.stringify(manifest("T-101", anchor, [{ kind: "cmd", cmd: 'node -e "process.exit(0)"' }]), null, 2)}\n`,
  );
  write(
    "checks/tasks/T-102.json",
    `${JSON.stringify(manifest("T-102", anchor, [{ kind: "cmd", cmd: 'node -e "process.exit(0)"' }]), null, 2)}\n`,
  );
  write(
    "checks/tasks/T-103.json",
    `${JSON.stringify(manifest("T-103", anchor, [{ kind: "cmd", cmd: 'node -e "process.exit(0)"' }]), null, 2)}\n`,
  );
  write(
    "checks/tasks/T-104.json",
    `${JSON.stringify(manifest("T-104", anchor, [{ kind: "cmd", cmd: 'node -e "process.exit(3)"' }]), null, 2)}\n`,
  );
  write(
    "checks/tasks/T-105.json",
    `${JSON.stringify(manifest("T-105", anchor, [{ kind: "cmd", cmd: 'node -e "process.exit(0)"' }]), null, 2)}\n`,
  );
  write(
    "checks/tasks/T-106.json",
    `${JSON.stringify(
      manifest("T-106", anchor, [{ kind: "cmd", cmd: 'test "$(cat src/a.txt)" = good' }]),
      null,
      2,
    )}\n`,
  );
  write(
    "checks/tasks/T-107.json",
    `${JSON.stringify(manifest("T-107", anchor, [{ kind: "cmd", cmd: 'node -e "process.exit(0)"' }]), null, 2)}\n`,
  );
  // Manifests stay untracked: their `base` field names the commit they gate, so they cannot
  // live inside that commit without a self-reference.
  BASE = anchor;
  console.log(`demo repo: ${ROOT}`);
  console.log(`base: ${BASE}`);

  // 1. An in-scope change passes both gates.
  const c1 = caseCommit("case-1", () => write("src/a.txt", "one\ntwo\n"), ["src/a.txt"]);
  const r1 = runGuard("T-101", BASE, c1);
  console.log(`\nCASE 1 — in-scope commit\n${r1.lines.map((line) => `  ${line}`).join("\n")}`);
  check(
    "in-scope commit passes",
    r1.status === 0 && r1.lines.includes("SCOPE_PASS") && r1.lines.includes("GATE_PASS"),
    `exit=${r1.status}`,
  );

  // 2. A change outside write_scope fails Gate 0.
  const c2 = caseCommit("case-2", () => write("outside.txt", "nope\n"), ["outside.txt"]);
  const r2 = runGuard("T-102", BASE, c2);
  console.log(`\nCASE 2 — out-of-scope commit\n${r2.lines.map((line) => `  ${line}`).join("\n")}`);
  check("out-of-scope commit fails", r2.status === 1 && r2.lines.includes("SCOPE_FAIL"), `exit=${r2.status}`);

  // 3. A delete under contract_paths fails even though the path is inside write_scope.
  const c3 = caseCommit("case-3", () => git("rm", "-q", "src/contract.md"), []);
  const r3 = runGuard("T-103", BASE, c3);
  console.log(`\nCASE 3 — delete under contract_paths\n${r3.lines.map((line) => `  ${line}`).join("\n")}`);
  check("contract delete fails", r3.status === 1 && r3.lines.includes("SCOPE_FAIL"), `exit=${r3.status}`);

  // 4. Scope is clean but the acceptance command fails.
  const c4 = caseCommit("case-4", () => write("src/a.txt", "one\nthree\n"), ["src/a.txt"]);
  const r4 = runGuard("T-104", BASE, c4);
  console.log(`\nCASE 4 — failing acceptance command\n${r4.lines.map((line) => `  ${line}`).join("\n")}`);
  check(
    "failing acceptance command fails",
    r4.status === 1 && r4.lines.includes("SCOPE_PASS") && r4.lines.includes("GATE_FAIL"),
    `exit=${r4.status}`,
  );

  // 5. A Manifest written in the shared contract's shape (task_id, no Guard dialect) enters.
  const c5 = caseCommit("case-5", () => write("src/a.txt", "one\nfive\n"), ["src/a.txt"]);
  const r5 = runGuard("T-105", BASE, c5);
  console.log(`\nCASE 5 — shared-contract Manifest\n${r5.lines.map((line) => `  ${line}`).join("\n")}`);
  check(
    "shared-contract Manifest passes",
    r5.status === 0 && r5.lines.includes("SCOPE_PASS") && r5.lines.includes("GATE_PASS"),
    `exit=${r5.status}`,
  );

  // 6. The commit says `bad`; an uncommitted repair says `good`. Acceptance must not see the repair.
  const c6 = caseCommit("case-6", () => write("src/a.txt", "bad\n"), ["src/a.txt"]);
  write("src/a.txt", "good\n");
  const r6 = runGuard("T-106", BASE, c6);
  git("checkout", "--", "src/a.txt");
  console.log(`\nCASE 6 — tracked edit on top of --commit\n${r6.lines.map((line) => `  ${line}`).join("\n")}`);
  check(
    "uncommitted tracked repair does not certify the commit",
    r6.status === 1 &&
      r6.lines.includes("SCOPE_PASS") &&
      r6.lines.includes("GATE_FAIL") &&
      r6.stderr.includes("uncommitted tracked changes"),
    `exit=${r6.status}`,
  );

  // 7. The worktree is checked out somewhere else entirely.
  const c7 = caseCommit("case-7", () => write("src/a.txt", "one\nseven\n"), ["src/a.txt"]);
  git("checkout", "-q", BASE);
  const r7 = runGuard("T-107", BASE, c7);
  console.log(`\nCASE 7 — worktree HEAD differs from --commit\n${r7.lines.map((line) => `  ${line}`).join("\n")}`);
  check(
    "worktree HEAD mismatch fails",
    r7.status === 1 &&
      r7.lines.includes("SCOPE_PASS") &&
      r7.lines.includes("GATE_FAIL") &&
      r7.stderr.includes("does not match --commit"),
    `exit=${r7.status}`,
  );

  console.log(failures === 0 ? "\ndemo: PASS (7 cases)" : `\ndemo: FAIL (${failures} case(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
