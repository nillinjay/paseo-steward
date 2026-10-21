#!/usr/bin/env node
/**
 * LEG 13 acceptance — the five red-team breaks that DESIGN-V2 §15 closes.
 *
 * The six read-only legs (docs/redteam/R1..R6) all returned YES-WITH-PATCHES. The shared breaks were:
 * a brief cannot say which KIND of work it is (`brief_kind`), acceptance can only mean "a command exited 0"
 * (no numeric or external claim), success has only one name (`DONE`), and non-git or irreversible actions
 * are invisible to the protocol.
 *
 * This check is deliberately thin: a fake `paseo` logs the real dispatch argv, so "creating a brief" means
 * what the daemon actually sends, not a string this file re-typed. The report template and the shared
 * acceptance schema are read from the tree.
 *
 * Red before §15, green after.
 */
const { execFileSync } = require("node:child_process");
const { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const os = require("node:os");

const REPO = join(__dirname, "..");
const SERVER = process.env.BUNDLE ?? "/tmp/steward-leg13-server.cjs";
const SHARED = "/tmp/steward-leg13-shared.cjs";
const TMP = join(os.tmpdir(), `leg13-${process.pid}`);

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function iso(minutesOffset) {
  return new Date(Date.now() + minutesOffset * 60_000).toISOString().slice(0, 16) + "Z";
}

const STEWARD = "aaaa1111-0000-4000-8000-000000000001";

function leaseBlock() {
  return [
    "# COMMAND", "",
    "## Lease", "",
    "    session=pi:test",
    "    paseo-agent=(none — no steward)",
    "    since=2026-10-20T00:00Z",
    `    heartbeat=${iso(0)}`,
    "    state=released",
    "", "## Ready queue", "",
    "| leg | goal |", "|---|---|",
    "| **99** | something worth doing |",
    "", "## Dispatch ledger", "",
  ].join("\n");
}

function project(root) {
  mkdirSync(join(root, "control"), { recursive: true });
  writeFileSync(join(root, "control", "COMMAND.md"), leaseBlock());
}

function row(root) {
  return {
    root, workspace: "wks_test", provider: "pi/test", thinking: "high",
    juniorProvider: "opencode/test", intervalMinutes: 20, nextTickAt: null, lastDispatchAt: null,
    lastPokeAt: null, lastPokeFingerprint: null, pokeFailureCount: 0, pokeFailureAgent: null,
    lazyMode: true, enabled: true,
    leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true, autoAllowShell: true,
  };
}

async function main() {
  for (const [entry, out] of [["server/steward.ts", SERVER], ["shared/steward.ts", SHARED]]) {
    execFileSync("npx", [
      "esbuild", entry, "--bundle", "--platform=node", "--format=cjs",
      "--outfile=" + out, "--external:@getpaseo/*",
    ], { cwd: REPO, stdio: "ignore" });
  }

  mkdirSync(TMP, { recursive: true });
  process.env.NODE_PATH = join(REPO, "node_modules");
  require("node:module").Module._initPaths();

  const shared = require(SHARED);

  const required = shared.REQUIRED_MANIFEST_FIELDS;
  const outcomes = shared.TERMINAL_OUTCOMES;
  check("shared contract publishes the required Manifest fields", Array.isArray(required) && required.length >= 12,
    Array.isArray(required) ? required.join(", ") : String(required));
  check("shared contract publishes the five terminal outcomes", Array.isArray(outcomes) && outcomes.length === 5,
    Array.isArray(outcomes) ? outcomes.join(", ") : String(outcomes));

  // 1. CREATE A BRIEF — the steward's real dispatch argv, captured through a fake `paseo`.
  const root = join(TMP, "project");
  project(root);
  const fake = join(TMP, "fake-paseo");
  const argvLog = join(TMP, "argv.log");
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('[]');
`);
  chmodSync(fake, 0o755);

  const cfgPath = join(TMP, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ projects: [row(root)], audit: [], auditEvictions: {} }, null, 2));
  process.env.PASEO_STEWARD_CONFIG = cfgPath;
  process.env.PASEO_BIN = fake;

  delete require.cache[require.resolve(SERVER)];
  const server = require(SERVER);
  await server.wheelPass("interval");

  const lines = existsSync(argvLog)
    ? readFileSync(argvLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
  const run = lines.map((line) => JSON.parse(line)).find((args) => args[0] === "run");
  const brief = run ? run[run.length - 1] : "";
  check("dispatching creates a steward brief", Boolean(run) && brief.includes("DISPATCH BRIEF"),
    run ? `${run.length} argv` : "no `run` invocation");

  for (const field of required ?? []) {
    const present = new RegExp(`^${field}:`, "m").test(brief);
    const rule = field === "base"
      ? /^base:\s*40-hex\b/m.test(brief)
      : true;
    check(`the brief emits ${field}`, present && rule, present ? (rule ? "" : "base is not a 40-hex sha") : "missing");
  }

  // 2. THREE ACCEPTANCE KINDS — a measurement must bind a number, not just an exit code.
  const predicate = {
    metric: "first_pass_rate",
    op: ">=",
    value: 0.8,
    unit: "ratio",
    window: "2026-10-13..2026-10-20",
    definition: "legs that passed Gate 1 on their first run / all legs dispatched",
    truncation: "none",
  };
  const measurement = { kind: "measurement", cmd: "node checks/metrics.cjs", predicate };
  check("a cmd acceptance parses", shared.AcceptanceSchema.safeParse({ kind: "cmd", cmd: "npx tsc --noEmit" }).success);
  check("an external acceptance names its party",
    shared.AcceptanceSchema.safeParse({ kind: "external", party: "ISO 27001 auditor" }).success);
  check("a measurement acceptance carries a numeric predicate",
    shared.AcceptanceSchema.safeParse(measurement).success);
  check("a measurement acceptance without a predicate is refused",
    !shared.AcceptanceSchema.safeParse({ kind: "measurement", cmd: "node checks/metrics.cjs" }).success);
  check("a metric without a window, definition or truncation rule is refused",
    !shared.AcceptanceSchema.safeParse({
      kind: "measurement", cmd: "node checks/metrics.cjs",
      predicate: { metric: "first_pass_rate", op: ">=", value: 0.8 },
    }).success);

  // 3. THE THREE RULES (§15.4), expressed where the Manifest can enforce them.
  const base = {
    task_id: "T-900", lane: "standard", tier: "junior", risk: "R1",
    brief_kind: "delivery", base: "a".repeat(40),
    write_scope: ["shared/"], forbidden: [], ops_actions: [],
    acceptance: [{ kind: "cmd", cmd: "npx tsc --noEmit" }],
    expires_at: null, p0_or_p1: "P0", cancel_how: "not cancellable — evidence stays on the branch",
    reference: ["DESIGN-V2.md"],
  };
  check("a 40-hex base manifest parses", shared.ManifestSchema.safeParse(base).success);
  check("HEAD is refused as a base", !shared.ManifestSchema.safeParse({ ...base, base: "HEAD" }).success);
  check("an external acceptance requires an expires_at",
    !shared.ManifestSchema.safeParse({
      ...base, acceptance: [{ kind: "external", party: "auditor" }],
    }).success);
  check("an irreversible ops action requires an owner ack id",
    !shared.ManifestSchema.safeParse({
      ...base, ops_actions: [{ cmd: "systemctl restart orders-api", reversible: false }],
    }).success);
  check("an incident brief requires its runbook",
    !shared.ManifestSchema.safeParse({ ...base, brief_kind: "incident", ops_actions: [] }).success);
  check("a documented irreversible action with an owner ack id parses",
    shared.ManifestSchema.safeParse({
      ...base, ops_actions: [{ cmd: "systemctl restart orders-api", reversible: false, owner_ack_id: "ack-42" }],
    }).success);

  // 4. THE REPORT TEMPLATE enumerates five terminal outcomes, each with its condition.
  const report = readFileSync(join(REPO, "docs/templates/worker-report.md"), "utf8");
  for (const outcome of outcomes ?? []) {
    const condition = new RegExp(`${outcome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+[—-]\\s+\\S`);
    const line = report.split("\n").find((text) => condition.test(text)) ?? "";
    check(`the report template defines ${outcome} with a one-line condition`, line !== "", line.trim() || "missing");
  }

  console.log(`\n${failures === 0 ? "OK" : `${failures} FAILED`}`);
  rmSync(TMP, { recursive: true, force: true });
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("check crashed:", error);
  process.exit(2);
});
