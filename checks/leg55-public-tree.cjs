#!/usr/bin/env node
/**
 * LEG 55 — a stranger's clone is green, and nothing private is in it.
 *
 * tools/build-public-tree.sh assembles what gets published. This check builds it into a throwaway directory, copies
 * node_modules in (no network), and runs `npx tsc --noEmit` and `./tools/suite.sh` there with an empty PASEO_HOME, so
 * there is no daemon config either. Checks whose fixtures stay private must SKIP there, not fail. tools/suite.sh prints
 * one PASS/FAIL line per check and drops the output of a passing one, so each guarded check is also run on its own to
 * prove its SKIP line fires.
 *
 * It also holds what must never be published: this project's plan.md and control/COMMAND.md content, its task
 * manifests, reviews/ and the rest of the ledger, and a person's home path.
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");
const { skip, missingLedger } = require("./preconditions.cjs");

const REPO = path.resolve(__dirname, "..");

// leg43 runs the real suite again; this check already ran in the outer suite.
if (process.env.LEG43_NESTED_SUITE === "1") {
  console.log("PASS nested leg55 skipped: the outer run already exercised this check");
  process.exit(0);
}
const missingPlan = missingLedger("plan.md", REPO);
if (missingPlan) skip(`${missingPlan}; there is no private ledger to keep out of a public tree`);
if (!fs.existsSync(path.join(REPO, "node_modules"))) skip("no node_modules to copy in (run npm ci first)");

// Checks whose preconditions the public tree lacks: each must print its SKIP line there and exit 0.
const GUARDED = ["leg8-registry", "leg11-no-owner-questions", "leg21-roster", "leg36-peer-direct", "leg37-peer-scope",
  "leg39-steer-safety", "leg50-roster-models", "leg51-dispatcher-manifest"];
// The ledger, as tools/build-public-tree.sh lists it. plan.md and control/ are published as templates only.
const PRIVATE_PATHS = ["plan.md", "control", "checks/tasks", "reviews", "output", "STATUS.md", "AGENTS.md"];
const PRIVATE_SOURCES = ["plan.md", "control/COMMAND.md"];
// /home/<name>/ names a person unless it is one of the placeholders the fixtures and comments use.
const PLACEHOLDER_HOMES = new Set(["dev", "example", "owner", "other", "private"]);
const HOME_PATH = /\/home\/([A-Za-z0-9._-]+)\//g;

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "steward-leg55-")));
const TREE = path.join(TMP, "tree");
const EMPTY_PASEO_HOME = path.join(TMP, "paseo-home");
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

/** Every text file under `root` as { rel, text }, node_modules excluded. */
function textFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(full);
        if (!buf.includes(0)) out.push({ rel: path.relative(root, full), text: buf.toString("utf8") });
      }
    }
  };
  walk(root);
  return out;
}

const isPrivate = (rel) => PRIVATE_PATHS.some((p) => rel === p || rel.startsWith(`${p}/`));
const longLines = (text) => text.split("\n").map((l) => l.trim()).filter((l) => l.length >= 40);

/**
 * Lines of plan.md / control/COMMAND.md that only the ledger says: at least 40 characters, and absent from every
 * public file this repository publishes as-is (the four owner-only classes, for instance, are also in the worker-brief
 * template). Returns the published files that contain one.
 */
function ledgerLeaks(files) {
  const published = new Set();
  for (const { rel, text } of files) {
    const source = path.join(REPO, rel);
    if (!isPrivate(rel) && fs.existsSync(source) && fs.readFileSync(source, "utf8") === text) {
      for (const line of longLines(text)) published.add(line);
    }
  }
  const leaks = [];
  const distinctive = {};
  for (const rel of PRIVATE_SOURCES) {
    const lines = new Set(longLines(fs.readFileSync(path.join(REPO, rel), "utf8")).filter((l) => !published.has(l)));
    distinctive[rel] = lines.size;
    for (const file of files) {
      const hit = longLines(file.text).find((l) => lines.has(l));
      if (hit) leaks.push(`${file.rel} carries ${rel}: "${hit.slice(0, 60)}"`);
    }
  }
  return { leaks, distinctive };
}

function personalPaths(files) {
  const hits = [];
  for (const { rel, text } of files) {
    for (const m of text.matchAll(HOME_PATH)) if (!PLACEHOLDER_HOMES.has(m[1])) hits.push(`${rel}: ${m[0]}`);
  }
  return hits;
}

try {
  // The detectors must be able to fail, or a clean result means nothing.
  check("the detectors flag a planted ledger line and a planted home path", () => {
    const plan = fs.readFileSync(path.join(REPO, "plan.md"), "utf8");
    const planted = ledgerLeaks([{ rel: "notes/copied.md", text: plan }]);
    assert.ok(planted.distinctive["plan.md"] > 0, "plan.md has no line distinctive enough to detect");
    assert.ok(planted.distinctive["control/COMMAND.md"] > 0, "COMMAND.md has no line distinctive enough to detect");
    assert.ok(planted.leaks.some((l) => l.startsWith("notes/copied.md carries plan.md")), "a copied plan.md went unnoticed");
    // Assembled at run time: the literal would itself be a personal path in the published tree.
    assert.equal(personalPaths([{ rel: "x.ts", text: `const p = '${["", "home", "someone", "code"].join("/")}';` }]).length, 1);
    assert.equal(personalPaths([{ rel: "x.ts", text: "'/home/dev/code' '/home/private/*'" }]).length, 0);
  });

  const build = spawnSync("bash", [path.join(REPO, "tools", "build-public-tree.sh"), TREE], { encoding: "utf8" });
  check("tools/build-public-tree.sh builds the tree", () => {
    assert.equal(build.status, 0, `exit ${build.status}: ${build.stderr}`);
  });
  if (build.status !== 0) throw new Error("no tree to test");

  const files = textFiles(TREE);
  check("no file in the public tree names a person's home directory", () => {
    const hits = personalPaths(files);
    assert.deepEqual(hits, [], hits.slice(0, 5).join("; "));
  });
  check("plan.md and control/COMMAND.md in the public tree are templates", () => {
    for (const rel of PRIVATE_SOURCES) assert.match(String(missingLedger(rel, TREE)), /public template/, rel);
  });
  check("no line of this repository's plan.md or control/COMMAND.md is published", () => {
    const { leaks } = ledgerLeaks(files);
    assert.deepEqual(leaks, [], leaks.slice(0, 5).join("; "));
  });
  check("no reviews/, output/, STATUS.md, AGENTS.md or control/RESUME.md is published", () => {
    const found = files.map((f) => f.rel).filter((rel) => rel.split(path.sep).includes("reviews") ||
      ["output", "STATUS.md", "AGENTS.md", "control/RESUME.md"].some((p) => rel === p || rel.startsWith(`${p}/`)));
    assert.deepEqual(found, []);
    assert.ok(!fs.existsSync(path.join(TREE, "reviews")), "reviews/ exists");
  });
  check("no task manifest from this repository is published", () => {
    const ours = new Set(fs.readdirSync(path.join(REPO, "checks", "tasks")));
    const published = fs.readdirSync(path.join(TREE, "checks", "tasks"));
    assert.ok(published.length > 0, "the build wrote no example manifest");
    assert.deepEqual(published.filter((name) => ours.has(name)), []);
  });

  fs.cpSync(path.join(REPO, "node_modules"), path.join(TREE, "node_modules"), { recursive: true, verbatimSymlinks: true });
  fs.mkdirSync(EMPTY_PASEO_HOME);
  const env = { ...process.env, PASEO_HOME: EMPTY_PASEO_HOME, npm_config_offline: "true" };
  delete env.LEG43_NESTED_SUITE;

  const tsc = spawnSync("npx", ["tsc", "--noEmit"], { cwd: TREE, env, encoding: "utf8", timeout: 300000 });
  check("npx tsc --noEmit exits 0 in the public tree", () => {
    assert.equal(tsc.status, 0, `exit ${tsc.status}: ${(tsc.stdout + tsc.stderr).split("\n").slice(0, 5).join(" | ")}`);
  });

  const suite = spawnSync("./tools/suite.sh", [], { cwd: TREE, env, encoding: "utf8", timeout: 900000 });
  check("./tools/suite.sh exits 0 in the public tree", () => {
    const failing = suite.stdout.split("\n").filter((l) => /^FAIL|^ {8}/.test(l)).slice(0, 8).join(" | ");
    assert.equal(suite.status, 0, `exit ${suite.status}: ${failing || suite.stderr}`);
    assert.match(suite.stdout, /SUITE GREEN/);
  });

  let skips = 0;
  for (const name of GUARDED) {
    const run = spawnSync("node", [path.join("checks", `${name}.cjs`)], { cwd: TREE, env, encoding: "utf8", timeout: 300000 });
    check(`${name} skips with a reason in the public tree`, () => {
      assert.equal(run.status, 0, `exit ${run.status}: ${(run.stdout + run.stderr).slice(-400)}`);
      const line = run.stdout.split("\n").find((l) => l.startsWith(`SKIP ${name}: `));
      assert.ok(line, `no "SKIP ${name}: <reason>" line`);
      skips += 1;
    });
  }
  check("the public tree prints at least one SKIP", () => assert.ok(skips > 0));
} catch (error) {
  failures += 1;
  console.log(`FAIL  leg55 crashed — ${error.message}`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

if (failures) {
  console.log(`FAIL  leg55: ${failures} failing`);
  process.exit(1);
}
console.log("leg55 public tree ok");
