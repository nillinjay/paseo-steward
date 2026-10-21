#!/usr/bin/env node
/**
 * T-120: a KNOWN-OPEN ledger for the four P1 defects in the second review.
 *
 * This is deliberately NOT a passing test suite. It reproduces N1..N4 against the bundled server and
 * compares the defects it can still observe with the list declared below. Exit 0 means "the declared
 * set is exactly what runs today"; a repair that flips a declared defect to FIXED makes this file fail
 * until the declaration is updated. An INCONCLUSIVE result is always a failure.
 *
 * The ordinary acceptance command for a repair leg is `node checks/accept.cjs <leg>`. This file stays
 * red-by-design for the repair leg that fixes N1..N4: delete each repaired line from KNOWN_OPEN only
 * after the evidence shows the behavior is gone.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const os = require("node:os");
const { join } = require("node:path");

const KNOWN_OPEN = [];  // N1-N4 fixed by T-119; keep this empty and delete a name only when it regresses

const REPO = join(__dirname, "..");
const TMP = mkdtempSync(join(os.tmpdir(), "repro-review2-"));
const SERVER = join(TMP, "server.cjs");
const SHARED = join(TMP, "shared.cjs");

const OWNER = "aaaa1111-0000-4000-8000-000000000001";
const WORKER = "bbbb2222-0000-4000-8000-000000000002";

const oneLine = (value) => String(value).replace(/\s+/g, " ").trim();

function bundle() {
  const common = ["--bundle", "--platform=node", "--format=cjs", "--external:@getpaseo/*"];
  execFileSync("npx", ["esbuild", "server/steward.ts", ...common, `--outfile=${SERVER}`], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
  });
  execFileSync("npx", ["esbuild", "shared/steward.ts", ...common, `--outfile=${SHARED}`], {
    cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
  });
}

function useFixture(name) {
  const dir = join(TMP, name);
  mkdirSync(join(dir, "control"), { recursive: true });
  const root = join(dir, "project");
  mkdirSync(join(root, "control"), { recursive: true });
  mkdirSync(join(root, "checks", "out"), { recursive: true });
  return { dir, root };
}

function writeCommand(root, extra = "") {
  writeFileSync(join(root, "control", "COMMAND.md"), [
    "# COMMAND",
    "",
    "## Lease",
    "",
    "    session=fixture",
    `    paseo-agent=${OWNER}`,
    "    heartbeat=2020-01-01T00:00Z",
    "    state=held",
    "",
    "## Dispatch ledger",
    "",
    "| leg | status | agent | note |",
    "|---|---|---|---|",
    "| T-fixture | DONE | fixture | seed row |",
    extra,
    "",
  ].join("\n"));
}

function writeConfig(dir, root, extra = {}) {
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({
    projects: [{
      root,
      workspace: "main",
      enabled: true,
      lazyMode: true,
      maxConcurrent: 2,
      pendingWakes: [],
      pokeFailureCount: 0,
      pokeFailureAgent: null,
      ...extra,
    }],
    audit: [],
    auditEvictions: {},
  }, null, 2));
  return file;
}

function writeCli(dir, { workspaces, agents, permits }) {
  const file = join(dir, "paseo");
  writeFileSync(file, `#!/usr/bin/env node
const a = process.argv.slice(2);
const out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const workspaces = ${JSON.stringify(workspaces)};
const agents = ${JSON.stringify(agents)};
const permits = ${JSON.stringify(permits)};
if (a[0] === "workspace" && a[1] === "ls") out(workspaces);
else if (a[0] === "agent" && a[1] === "ls") out(agents);
else if (a[0] === "permit" && a[1] === "ls") out(permits);
else out([]);
`);
  chmodSync(file, 0o755);
  return file;
}

function environment(dir, config, cli) {
  process.env.PASEO_STEWARD_CONFIG = config;
  process.env.PASEO_BIN = cli;
  process.env.PASEO_STEWARD_PROJECT = join(dir, "paseo-project");
  return { config, cli };
}

function git(root, ...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function writeArtifact(root, name, record) {
  const relative = `checks/out/${name}`;
  writeFileSync(join(root, relative), `${JSON.stringify(record, null, 2)}\n`);
  return relative;
}

function methodCase(id, method) {
  return async () => {
    try {
      return await method();
    } catch (error) {
      return { id, status: "INCONCLUSIVE", evidence: `harness error: ${oneLine(error.message)}` };
    }
  };
}

async function n1(server) {
  const id = "N1";
  const { dir, root } = useFixture("n1");
  writeCommand(root);
  const config = writeConfig(dir, root);
  const cli = writeCli(dir, {
    workspaces: [{ project: "project", workspaceId: "main", isolation: "local", cwd: root }],
    agents: [
      { id: OWNER, cwd: root, name: "steward", status: "running" },
      { id: WORKER, cwd: root, name: "worker", status: "idle" },
    ],
    permits: [{ id: "p1", agentId: WORKER, name: "CodexBash", description: "run command" }],
  });
  environment(dir, config, cli);

  const state = await server.readSteward({ project: root });
  const pending = state.permissions.pending.find((p) => p.requestId === "p1");
  if (!pending) {
    return { id, status: "INCONCLUSIVE", evidence: "fixture did not expose pending p1 to the sweep" };
  }

  const answers = [];
  const ref = {
    cwd: root,
    refresh: async () => { throw new Error("snapshot unavailable"); },
    respondToPermission: async (response) => { answers.push(response); },
  };
  const result = await server.controlSteward(
    { action: "answer-pending", project: root },
    { paseo: { agents: { ref: () => ref } } },
  );
  const granted = answers.find((a) => a.response?.behavior === "allow");
  if (granted) {
    return {
      id,
      status: "DEFECT PRESENT",
      evidence: `refresh threw but the sweep sent ${JSON.stringify(granted)} for p1 (result ${oneLine(JSON.stringify(result))})`,
    };
  }
  return {
    id,
    status: "FIXED",
    evidence: `refresh threw and no allow was sent; answers=${JSON.stringify(answers)}`,
  };
}

async function n2(server, shared) {
  const id = "N2";
  const { dir, root } = useFixture("n2");
  writeCommand(root);
  const config = writeConfig(dir, root);
  const cli = writeCli(dir, { workspaces: [], agents: [], permits: [] });
  environment(dir, config, cli);

  const cases = [
    { name: "tmp traversal", detail: "Scope: /tmp/../home/private/*" },
    { name: "source traversal", detail: "Scope: /home/dev/code/paseo/../private/*" },
  ];
  const observed = [];
  for (const [index, item] of cases.entries()) {
    const answers = [];
    const ref = {
      cwd: root,
      refresh: async () => ({ agent: { pendingPermissions: [] } }),
      respondToPermission: async (response) => { answers.push(response); },
    };
    await server.onPermissionRequested({
      agent: { id: WORKER, cwd: root, title: "worker" },
      request: { id: `p2-${index}`, name: "external_directory", kind: "tool", description: item.detail },
    }, { paseo: { agents: { ref: () => ref } } });
    observed.push({
      name: item.name,
      detail: item.detail,
      classified: shared.classifyRequest("external_directory", "tool", item.detail),
      behavior: answers[0]?.response?.behavior ?? "left pending",
    });
  }
  const granted = observed.filter((entry) => entry.behavior === "allow");
  if (granted.length > 0) {
    return {
      id,
      status: "DEFECT PRESENT",
      evidence: granted.map((entry) => `${entry.name} "${entry.detail}" classified ${entry.classified}, sent allow`).join("; "),
    };
  }
  return {
    id,
    status: "FIXED",
    evidence: observed.map((entry) => `${entry.name} classified ${entry.classified}, ${entry.behavior}`).join("; "),
  };
}

function acceptanceFixture(name) {
  const { dir, root } = useFixture(name);
  writeCommand(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "repro-review2@example.invalid");
  git(root, "config", "user.name", "repro-review2");
  writeFileSync(join(root, "work.txt"), "fixture commit\n");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture commit");
  const head = git(root, "rev-parse", "HEAD").toLowerCase();
  const config = writeConfig(dir, root);
  const cli = writeCli(dir, { workspaces: [], agents: [], permits: [] });
  environment(dir, config, cli);
  return { root, head };
}

async function n3(server) {
  const id = "N3";
  const task = "T-bad";
  const { root, head } = acceptanceFixture("n3");
  writeArtifact(root, `guard-${task}-${head}.json`, {
    task,
    commit: head,
    verdict: "FAIL",
    gate: { commands: [{ cmd: "true", exit_code: 0 }] },
  });

  const state = await server.readSteward({ project: root });
  const row = state.acceptance.find((entry) => entry.task === task);
  if (!row || row.artifactExists !== true || row.verdict !== "FAIL") {
    return { id, status: "INCONCLUSIVE", evidence: `fixture artifact not visible to acceptance state: ${oneLine(JSON.stringify(row))}` };
  }

  const ledgerBefore = readFileSync(join(root, "control", "COMMAND.md"), "utf8");
  const result = await server.controlSteward({ action: "accept", project: root, task, commit: head });
  const ledgerAfter = readFileSync(join(root, "control", "COMMAND.md"), "utf8");
  if (result.ok === true) {
    return {
      id,
      status: "DEFECT PRESENT",
      evidence: `verdict FAIL was accepted: ${oneLine(result.message)} (ledger changed=${ledgerAfter !== ledgerBefore})`,
    };
  }
  return {
    id,
    status: "FIXED",
    evidence: `verdict FAIL was refused: ${oneLine(result.message)} (ledger changed=${ledgerAfter !== ledgerBefore})`,
  };
}

async function n4(server) {
  const id = "N4";
  const task = "T-ok";
  const { root, head } = acceptanceFixture("n4");
  // The producer's successful verdict is PASS with both aggregates true (review N3 made "accepted" obsolete).
  writeArtifact(root, `${task}-${head}.json`, {
    leg: task,
    sha: head,
    verdict: "PASS",
    scope: { pass: true },
    gate: { pass: true, commands: [{ cmd: "true", exitCode: 0 }] },
    commands: [{ cmd: "true", exitCode: 0 }],
  });

  const state = await server.readSteward({ project: root });
  const row = state.acceptance.find((entry) => entry.task === task);
  if (!row || row.artifactExists !== true || row.allCommandsPassed !== true) {
    return { id, status: "INCONCLUSIVE", evidence: `fixture artifact not visible to acceptance state: ${oneLine(JSON.stringify(row))}` };
  }

  const ledgerBefore = readFileSync(join(root, "control", "COMMAND.md"), "utf8");
  const result = await server.controlSteward({ action: "accept", project: root, task, commit: head });
  const ledgerAfter = readFileSync(join(root, "control", "COMMAND.md"), "utf8");
  if (ledgerAfter !== ledgerBefore) {
    const added = ledgerAfter.slice(ledgerBefore.length).trim();
    return {
      id,
      status: "DEFECT PRESENT",
      evidence: `acceptance wrote into the supervised project: ${oneLine(added || result.message)}`,
    };
  }
  if (result.ok === true) {
    return {
      id,
      status: "FIXED",
      evidence: `acceptance succeeded without changing control/COMMAND.md: ${oneLine(result.message)}`,
    };
  }
  return {
    id,
    status: "INCONCLUSIVE",
    evidence: `acceptance did not reach the ledger path, so the write boundary was not exercised: ${oneLine(result.message)}`,
  };
}

function declaredLine(id) {
  const lines = readFileSync(__filename, "utf8").split("\n");
  const index = lines.findIndex((line) => new RegExp(`^\\s*"${id}",?\\s*$`).test(line));
  return index < 0 ? "(KNOWN_OPEN)" : `line ${index + 1}`;
}

function report(results) {
  for (const result of results) {
    console.log(`${result.id} ${result.status}  ${oneLine(result.evidence)}`);
  }
  const present = results.filter((r) => r.status === "DEFECT PRESENT");
  const fixed = results.filter((r) => r.status === "FIXED");
  const inconclusive = results.filter((r) => r.status === "INCONCLUSIVE");
  const declared = new Set(KNOWN_OPEN);
  const observed = new Set(present.map((r) => r.id));

  const sameSet = declared.size === observed.size && [...declared].every((id) => observed.has(id));
  const clean = inconclusive.length === 0 && sameSet;

  for (const result of fixed) {
    if (declared.has(result.id)) {
      console.log(`ledger: ${result.id} is FIXED but still declared — delete ${result.id} at ${declaredLine(result.id)} from KNOWN_OPEN`);
    }
  }
  for (const result of present) {
    if (!declared.has(result.id)) {
      console.log(`ledger: ${result.id} is an undeclared defect — add it to KNOWN_OPEN or the ledger is incomplete`);
    }
  }
  for (const result of inconclusive) {
    console.log(`ledger: ${result.id} is INCONCLUSIVE — a harness failure is never a pass`);
  }
  if (!sameSet && present.length === 0 && fixed.length === 0 && inconclusive.length === 0) {
    console.log("ledger: no findings were produced");
  }

  console.log(`ledger: ${present.length} known-open, ${fixed.length} fixed, ${inconclusive.length} inconclusive`);
  return clean ? 0 : 1;
}

async function main() {
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module")._initPaths();

  let server;
  let shared;
  let bundleError = null;
  try {
    bundle();
    server = require(SERVER);
    shared = require(SHARED);
  } catch (error) {
    bundleError = error instanceof Error ? error.message : String(error);
  }

  const cases = [
    ["N1", n1],
    ["N2", n2],
    ["N3", n3],
    ["N4", n4],
  ];
  const results = [];
  for (const [id, method] of cases) {
    if (bundleError) {
      results.push({ id, status: "INCONCLUSIVE", evidence: `bundling failed: ${oneLine(bundleError)}` });
      continue;
    }
    results.push(await methodCase(id, () => method(server, shared))());
  }

  const code = report(results);
  if (code === 0) {
    rmSync(TMP, { recursive: true, force: true });
  } else {
    console.error(`fixtures: ${TMP}`);
  }
  process.exitCode = code;
}

main().catch((error) => {
  console.error(`repro harness crashed: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 2;
});
