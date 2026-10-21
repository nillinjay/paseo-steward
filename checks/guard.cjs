#!/usr/bin/env node
/**
 * Guard 0/1 — deterministic scope and acceptance gate.
 *
 *   node checks/guard.cjs check --task <id> --base <sha> --commit <sha> --worktree <path>
 *
 * Gate 0 reads the Manifest at <worktree>/checks/tasks/<id>.json and validates it with the shared
 * `ManifestSchema` (one contract, no Guard dialect), then compares the real `git diff --name-status`
 * between base and commit against `write_scope`. A path outside the scope fails. A delete or rename under
 * a declared `contract_paths` entry fails. A path that matches `forbidden` (defaults: `.env`, `*.lock`,
 * `.github/`) fails.
 *
 * Gate 1 first proves the worktree is the tree of `--commit`: HEAD must resolve to that commit and no
 * tracked file or untracked code file may be pending (checks/tasks/ and checks/out/ are delegation records). Otherwise it refuses, because it would certify one commit while running
 * another tree's commands. It then runs every `acceptance` entry:
 *   - "script-name"                 a paseo.json script, or a shell command
 *   - { kind: "cmd", cmd }          a shell command; exit 0 passes
 *   - { kind: "measurement",
 *       cmd, predicate }            JSON on stdout, then a predicate; a JS expression string
 *                                   is evaluated with `data` bound to the parsed JSON, and an
 *                                   object { metric, op, value } is compared directly
 *   - { kind: "external", party }   prints `EXTERNAL <party>` and passes without running anything
 *
 * The only file written is <worktree>/checks/out/guard-<task>-<commit>.json.
 * Exit 0 only when Gate 0 and Gate 1 both pass.
 */
"use strict";

const { execFileSync, spawnSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { basename, dirname, join, resolve } = require("node:path");
const Module = require("node:module");

const DEFAULT_FORBIDDEN = [".env", "*.lock", ".github/"];
const DEFAULT_TIMEOUT_SECONDS = 600;

function usage(message) {
  if (message) process.stderr.write(`guard: ${message}\n`);
  process.stderr.write(
    "usage: node checks/guard.cjs check --task <id> --base <sha> --commit <sha> --worktree <path>\n",
  );
  process.exit(2);
}

function parseArgs(argv) {
  if (argv[0] !== "check") usage("expected the `check` subcommand");
  const out = {};
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) usage(`unexpected argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) usage(`missing value for --${key}`);
    out[key] = value;
    i += 1;
  }
  for (const key of ["task", "base", "commit", "worktree"]) {
    if (!out[key]) usage(`missing --${key}`);
  }
  return out;
}

function normalizePath(value) {
  return String(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function escapeRegex(value) {
  return value.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(char);
    }
  }
  return new RegExp(`^${out}$`);
}

function hasGlob(value) {
  return value.includes("*") || value.includes("?");
}

function matchesPath(path, pattern) {
  const file = normalizePath(path);
  const rule = normalizePath(pattern);
  if (rule.endsWith("/")) return file === rule.slice(0, -1) || file.startsWith(rule);
  if (hasGlob(rule)) {
    const regex = globToRegex(rule);
    if (rule.includes("/")) return regex.test(file);
    return regex.test(file) || regex.test(basename(file));
  }
  if (rule.includes("/")) return file === rule;
  return file === rule || file.startsWith(`${rule}/`) || basename(file) === rule;
}

function matchesAny(path, patterns) {
  return patterns.some((pattern) => matchesPath(path, pattern));
}

let manifestSchemaCache;

/**
 * The shared contract is TypeScript. Transpile it in-process so Guard validates with the one published
 * `ManifestSchema`, never a re-typed dialect. Loading the whole module also loads `@getpaseo/plugin`, so
 * resolution is anchored at the shared directory (and therefore its node_modules), not at this file.
 */
function loadManifestSchema() {
  if (manifestSchemaCache !== undefined) return manifestSchemaCache;
  const sharedPath = join(__dirname, "..", "shared", "steward.ts");
  if (!existsSync(sharedPath)) {
    manifestSchemaCache = { error: `shared contract not found: ${sharedPath}` };
    return manifestSchemaCache;
  }
  try {
    const ts = require("typescript");
    const source = readFileSync(sharedPath, "utf8");
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: sharedPath,
    }).outputText;
    const loaded = new Module(sharedPath, module);
    loaded.filename = sharedPath;
    loaded.paths = Module._nodeModulePaths(dirname(sharedPath));
    loaded._compile(compiled, sharedPath);
    if (!loaded.exports.ManifestSchema || typeof loaded.exports.ManifestSchema.safeParse !== "function") {
      manifestSchemaCache = { error: "shared contract does not export ManifestSchema" };
      return manifestSchemaCache;
    }
    manifestSchemaCache = { schema: loaded.exports.ManifestSchema };
  } catch (error) {
    manifestSchemaCache = { error: `could not load the shared Manifest contract: ${error.message}` };
  }
  return manifestSchemaCache;
}

function readManifest(worktree, task, registry) {
  // The registry is the STEWARD's tree, not the worker's worktree: a manifest that travels inside the
  // branch it authorises can be edited by the party it constrains. Look in the registry first, then fall
  // back to the worktree so a manifest committed on the branch is still usable.
  const candidates = [join(registry, "checks", "tasks", `${task}.json`), join(worktree, "checks", "tasks", `${task}.json`)];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) return { error: `manifest not found: tried ${candidates.join(", ")}` };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { error: `manifest is not valid JSON: ${error.message}` };
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { error: "manifest must be a JSON object" };
  }

  // One contract: anything `ManifestSchema` accepts enters, and only what it rejects is refused here.
  const loaded = loadManifestSchema();
  if (loaded.error) return { error: loaded.error };
  const validated = loaded.schema.safeParse(manifest);
  if (!validated.success) {
    const issues = validated.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    return { error: `manifest is not valid against the shared contract: ${issues}` };
  }

  const declaredTask = manifest.task_id ?? manifest.id;
  if (declaredTask !== task) {
    return { error: `manifest task_id ${JSON.stringify(declaredTask)} does not match --task ${task}` };
  }
  return { manifest };
}

function parseDiff(output) {
  const fields = output.split("\0");
  if (fields[fields.length - 1] === "") fields.pop();
  const changes = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index];
    index += 1;
    if (index >= fields.length) break;
    const first = fields[index];
    index += 1;
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = fields[index];
      index += 1;
      changes.push({ status, from: first, path: second ?? first, renamed: true });
    } else {
      changes.push({ status, path: first });
    }
  }
  return changes;
}

function runGate0(worktree, base, commit, manifest) {
  let changes;
  try {
    const output = execFileSync("git", ["diff", "--name-status", "-z", "--no-renames", base, commit], {
      cwd: worktree,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    changes = parseDiff(output);
  } catch (error) {
    return { pass: false, changes: [], violations: [`git diff failed: ${error.message.split("\n")[0]}`] };
  }

  const forbidden = [...DEFAULT_FORBIDDEN, ...(manifest.forbidden ?? [])];
  const contractPaths = Array.isArray(manifest.contract_paths) ? manifest.contract_paths : [];
  const violations = [];

  for (const change of changes) {
    const kind = change.status[0];
    const paths = change.renamed ? [change.from, change.path] : [change.path];

    for (const path of paths) {
      if (!matchesAny(path, manifest.write_scope)) {
        violations.push(`${change.status} ${path} is outside write_scope`);
      }
      if (matchesAny(path, forbidden)) {
        violations.push(`${change.status} ${path} matches a forbidden path`);
      }
      if (contractPaths.length > 0 && (kind === "D" || kind === "R") && matchesAny(path, contractPaths)) {
        violations.push(`${change.status} ${path} deletes or renames a declared contract path`);
      }
    }
  }

  return { pass: violations.length === 0, changes, violations };
}

/**
 * Gate 1 runs commands in the worktree, so the worktree must be the tree of `--commit`. A different HEAD,
 * or a tracked or untracked edit on top of it, would certify one commit while testing other file contents.
 */
function checkCheckout(worktree, commit) {
  let resolved;
  try {
    resolved = execFileSync("git", ["rev-parse", "--verify", `${commit}^{commit}`], {
      cwd: worktree,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    return `cannot resolve --commit ${commit} in the worktree: ${error.message.split("\n")[0]}`;
  }
  let head;
  try {
    head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8" }).trim();
  } catch (error) {
    return `cannot read the worktree HEAD: ${error.message.split("\n")[0]}`;
  }
  if (head !== resolved) {
    return `worktree HEAD ${head} does not match --commit ${resolved}; acceptance would test different file contents`;
  }
  let dirty;
  try {
    dirty = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: worktree,
      encoding: "utf8",
    }).split("\0").filter((entry) => {
      if (!entry) return false;
      // Only untracked delegation records are exempt. Tracked edits still change the named commit.
      return !(entry.startsWith("?? checks/tasks/") || entry.startsWith("?? checks/out/"));
    }).join("\n");
  } catch (error) {
    return `cannot read the worktree status: ${error.message.split("\n")[0]}`;
  }
  if (dirty !== "") {
    return `worktree has uncommitted tracked changes or untracked files on top of --commit ${resolved}: ${dirty}; acceptance would test different file contents`;
  }
  return null;
}

function loadScripts(worktree) {
  const file = join(worktree, "paseo.json");
  if (!existsSync(file)) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed.scripts && typeof parsed.scripts === "object" ? parsed.scripts : {};
  } catch {
    return {};
  }
}

function resolveScript(name, scripts) {
  const entry = scripts[name];
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return entry;
  if (entry && typeof entry.command === "string") return entry.command;
  return undefined;
}

function tail(text, lines = 20) {
  return String(text ?? "").replace(/\n$/, "").split("\n").slice(-lines).join("\n");
}

function runCommand(cmd, cwd, timeoutSeconds) {
  const started = Date.now();
  const result = spawnSync("/bin/sh", ["-c", cmd], {
    cwd,
    encoding: "utf8",
    timeout: Math.max(1, timeoutSeconds) * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: result.error && result.error.code === "ETIMEDOUT" ? 124 : (result.status ?? 1),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    durationMs: Date.now() - started,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
  };
}

function getByPath(value, path) {
  return String(path)
    .split(".")
    .reduce((current, key) => (current === undefined || current === null ? undefined : current[key]), value);
}

function compare(actual, op, expected) {
  switch (op) {
    case "<": return actual < expected;
    case "<=": return actual <= expected;
    case ">": return actual > expected;
    case ">=": return actual >= expected;
    case "==": return actual === expected;
    case "!=": return actual !== expected;
    default: throw new Error(`unknown predicate operator: ${op}`);
  }
}

function evaluatePredicate(predicate, stdout) {
  const trimmed = String(stdout ?? "").trim();
  if (trimmed === "") return { pass: false, detail: "measurement command produced no JSON on stdout" };

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch (error) {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        data = JSON.parse(lines[i]);
        break;
      } catch {
        // keep looking for a JSON line
      }
    }
    if (data === undefined) return { pass: false, detail: `stdout is not JSON: ${error.message}` };
  }

  try {
    if (typeof predicate === "string") {
      // eslint-disable-next-line no-new-func
      const fn = new Function("data", `return (${predicate});`);
      const value = fn(data);
      return { pass: value === true, detail: `predicate ${JSON.stringify(predicate)} -> ${JSON.stringify(value)}` };
    }
    if (predicate && typeof predicate === "object") {
      const metric = predicate.metric;
      const actual = metric === undefined ? data : getByPath(data, metric);
      const expected = predicate.value;
      const op = predicate.op ?? "==";
      if (typeof actual !== "number") {
        return { pass: false, detail: `metric ${JSON.stringify(metric)} is not a number (got ${JSON.stringify(actual)})` };
      }
      return {
        pass: compare(actual, op, expected),
        detail: `metric ${metric} = ${actual} ${op} ${expected}`,
      };
    }
    return { pass: false, detail: "predicate must be a JS expression or a { metric, op, value } object" };
  } catch (error) {
    return { pass: false, detail: `predicate evaluation failed: ${error.message}` };
  }
}

function resolveAcceptance(entry, scripts) {
  if (typeof entry === "string") {
    const script = resolveScript(entry, scripts);
    return { kind: "cmd", cmd: script ?? entry };
  }
  if (!entry || typeof entry !== "object") return { kind: "invalid", detail: `unreadable acceptance entry: ${JSON.stringify(entry)}` };
  if (entry.kind === "external" || entry.external !== undefined) {
    const party = entry.kind === "external" ? entry.party : entry.external;
    if (typeof party !== "string" || party === "") return { kind: "invalid", detail: "external acceptance needs a party" };
    return { kind: "external", party };
  }
  if (entry.kind === "measurement" || entry.measurement !== undefined) {
    const spec = entry.kind === "measurement" ? entry : entry.measurement;
    if (!spec || typeof spec.cmd !== "string" || spec.cmd === "") {
      return { kind: "invalid", detail: "measurement acceptance needs a cmd" };
    }
    if (spec.predicate === undefined || spec.predicate === null) {
      return { kind: "invalid", detail: "measurement acceptance needs a predicate" };
    }
    return { kind: "measurement", cmd: spec.cmd, predicate: spec.predicate };
  }
  if (entry.kind === "cmd" || typeof entry.cmd === "string") {
    if (typeof entry.cmd !== "string" || entry.cmd === "") return { kind: "invalid", detail: "cmd acceptance needs a cmd" };
    return { kind: "cmd", cmd: entry.cmd };
  }
  return { kind: "invalid", detail: `unknown acceptance kind: ${JSON.stringify(entry)}` };
}

function runGate1(worktree, manifest) {
  const scripts = loadScripts(worktree);
  const commands = [];
  let pass = true;

  for (const entry of manifest.acceptance) {
    const spec = resolveAcceptance(entry, scripts);
    if (spec.kind === "invalid") {
      pass = false;
      commands.push({ kind: "invalid", cmd: null, exit_code: 1, detail: spec.detail });
      process.stderr.write(`[gate] ${spec.detail}\n`);
      continue;
    }
    if (spec.kind === "external") {
      process.stdout.write(`EXTERNAL ${spec.party}\n`);
      commands.push({ kind: "external", cmd: null, party: spec.party, exit_code: 0, passed: true });
      continue;
    }

    const timeoutSeconds = entry.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const result = runCommand(spec.cmd, worktree, timeoutSeconds);
    const record = { kind: spec.kind, cmd: spec.cmd, exit_code: result.exitCode, duration_ms: result.durationMs };
    if (result.timedOut) record.timed_out = true;
    if (result.exitCode !== 0) {
      record.output_tail = tail(`${result.stdout}${result.stderr}`);
      pass = false;
    }
    if (spec.kind === "measurement") {
      if (result.exitCode !== 0) {
        record.passed = false;
        record.predicate_detail = "command failed; predicate not evaluated";
      } else {
        const evaluated = evaluatePredicate(spec.predicate, result.stdout);
        record.passed = evaluated.pass;
        record.predicate = spec.predicate;
        record.predicate_detail = evaluated.detail;
        if (!evaluated.pass) {
          pass = false;
          record.output_tail = tail(result.stdout);
        }
      }
    } else {
      record.passed = result.exitCode === 0;
    }
    if (!record.passed) process.stderr.write(`[gate] failed: ${spec.cmd}\n`);
    commands.push(record);
  }

  return { pass, commands };
}

function writeArtifact(worktree, task, commit, artifact) {
  try {
    const dir = join(worktree, "checks", "out");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `guard-${task}-${commit}.json`);
    writeFileSync(file, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return file;
  } catch (error) {
    process.stderr.write(`guard: could not write artifact: ${error.message}\n`);
    return null;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const worktree = resolve(args.worktree);

  if (!existsSync(worktree)) {
    process.stdout.write("SCOPE_FAIL\nGATE_FAIL\n");
    process.stderr.write(`guard: worktree does not exist: ${worktree}\n`);
    process.exit(1);
  }

  const loaded = readManifest(worktree, args.task, args.registry ?? process.cwd());
  if (loaded.error) {
    const artifact = {
      task: args.task,
      base: args.base,
      commit: args.commit,
      worktree,
      generated_at: new Date().toISOString(),
      scope: { pass: false, changes: [], violations: [loaded.error] },
      gate: { pass: false, skipped: true, commands: [] },
      verdict: "FAIL",
      error: loaded.error,
    };
    writeArtifact(worktree, args.task, args.commit, artifact);
    process.stdout.write("SCOPE_FAIL\nGATE_FAIL\n");
    process.stderr.write(`guard: ${loaded.error}\n`);
    process.exit(1);
  }

  const manifest = loaded.manifest;
  // A base may be typed short. Compare resolved commits, not strings: an operator who types `2f19b5b` for
  // `2f19b5b202f…` is naming the same commit, and a string comparison produced "2f19b5b does not match
  // 2f19b5b" on 2026-10-20, which is the kind of message that teaches people to distrust the gate.
  let baseMatches = manifest.base === args.base;
  if (!baseMatches) {
    const full = (sha) => {
      try {
        return require("node:child_process").execFileSync("git", ["rev-parse", `${sha}^{commit}`], {
          cwd: worktree, encoding: "utf8",
        }).trim();
      } catch { return ""; }
    };
    const want = full(args.base);
    baseMatches = want !== "" && want === manifest.base;
  }
  if (!baseMatches) {
    const detail = `manifest base ${manifest.base} does not match --base ${args.base} (they must name the same commit)`;
    const artifact = {
      task: args.task,
      base: args.base,
      commit: args.commit,
      worktree,
      generated_at: new Date().toISOString(),
      scope: { pass: false, changes: [], violations: [detail] },
      gate: { pass: false, skipped: true, commands: [] },
      verdict: "FAIL",
      error: detail,
    };
    writeArtifact(worktree, args.task, args.commit, artifact);
    process.stdout.write("SCOPE_FAIL\nGATE_FAIL\n");
    process.stderr.write(`guard: ${detail}\n`);
    process.exit(1);
  }

  const scope = runGate0(worktree, args.base, args.commit, manifest);
  for (const violation of scope.violations) process.stderr.write(`[scope] ${violation}\n`);
  process.stdout.write(scope.pass ? "SCOPE_PASS\n" : "SCOPE_FAIL\n");

  let gate;
  if (scope.pass) {
    const checkoutProblem = checkCheckout(worktree, args.commit);
    if (checkoutProblem) {
      process.stderr.write(`[gate] ${checkoutProblem}\n`);
      gate = { pass: false, skipped: false, commands: [], error: checkoutProblem };
      process.stdout.write("GATE_FAIL\n");
    } else {
      gate = runGate1(worktree, manifest);
      process.stdout.write(gate.pass ? "GATE_PASS\n" : "GATE_FAIL\n");
    }
  } else {
    gate = { pass: false, skipped: true, commands: [] };
    process.stdout.write("GATE_FAIL\n");
  }

  const verdict = scope.pass && gate.pass ? "PASS" : "FAIL";
  // Provenance: the consumer must be able to tell that the gate ran against the COMMITTED tree, not a checkout.
  // Without this field every artifact reads as unverifiable, which is honest but useless (2026-10-20).
  const dirty = (() => {
    try {
      return require("node:child_process")
        .execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: worktree, encoding: "utf8" })
        .trim();
    } catch {
      return "unreadable";
    }
  })();
  const artifact = {
    task: args.task,
    base: args.base,
    commit: args.commit,
    worktree,
    generated_at: new Date().toISOString(),
    scope,
    gate,
    verdict,
    provenance: { clean: dirty === "", commit: args.commit },
  };
  const file = writeArtifact(worktree, args.task, args.commit, artifact);
  if (file) process.stderr.write(`guard: artifact ${file}\n`);

  process.exit(verdict === "PASS" ? 0 : 1);
}

main();
