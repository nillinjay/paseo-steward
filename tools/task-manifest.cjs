#!/usr/bin/env node
// Emit the COMPLETE task manifest from what the dispatcher already knows, so a worker never writes its own.
//
// Why: on 2026-10-21 three legs failed their gate on tier / brief_kind / expires_at / p0_or_p1 because the worker
// wrote the manifest and guessed those keys. The dispatcher derives them here, and refuses (exit 3, one line) when a
// value cannot be derived instead of inventing one.
//
// The expected shape is learned at run time from the newest ACCEPTED manifest in checks/tasks/ (the one with
// `acceptedAt` and the highest task number), so this file does not keep a second copy of the schema.
//
// Usage: tools/task-manifest.cjs --task <T> --role <role> --risk <R0|R1|R2> --cancel-how <text>
//          [--brief <file|->] [--base <40-hex>] [--lane <lane>] [--write-scope a,b] [--forbidden a,b]
//          [--acceptance <json | "cmd=0; cmd=0; external:party">] [--allowed-commands "a | b"]
//          [--expires <ISO>] [--overrides <json>] [--tasks-dir <dir>] [--out <file>]
// Explicit flags win over the brief's header lines. `risk` and `cancel_how` are never read from the brief.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const REQUIRED = [
  "task_id", "lane", "risk", "base", "write_scope", "forbidden", "ops_actions", "acceptance",
  "tier", "p0_or_p1", "brief_kind", "expires_at", "cancel_how", "allowed_commands",
];

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(3);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) refuse(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq >= 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) refuse(`--${key} needs a value`);
    out[key] = value;
  }
  return out;
}

/**
 * The brief's `key: value` header lines. `lane: standard | risk: R2` yields both keys, while
 * `allowed_commands: a | b` stays one value: a ` | ` segment starts a new key only when it reads `key:`.
 */
function briefHeader(text) {
  const header = {};
  for (const line of text.split("\n")) {
    let key = null;
    const found = {};
    for (const part of line.split(" | ")) {
      const m = /^([a-z_]+):\s*(.*)$/.exec(part.trim());
      if (m) { key = m[1]; found[key] = m[2].trim(); }
      else if (key) found[key] += ` | ${part.trim()}`;
      else break;
    }
    for (const [k, v] of Object.entries(found)) if (!(k in header)) header[k] = v;
  }
  return header;
}

const list = (value, sep) => value.split(sep).map((s) => s.trim()).filter(Boolean);

function parseAcceptance(value) {
  if (value.trim().startsWith("[")) {
    try { return JSON.parse(value); } catch (error) { refuse(`--acceptance is not valid JSON: ${error.message}`); }
  }
  return list(value, ";").map((item) => {
    const ext = /^external\s*:\s*(.+)$/.exec(item);
    if (ext) return { kind: "external", party: ext[1].trim() };
    const m = /^(.*?)(?:=(\d+))?$/.exec(item);
    if (m[2] !== undefined && m[2] !== "0") refuse(`acceptance "${item}" expects exit ${m[2]}; only exit 0 can be expressed`);
    return { kind: "cmd", cmd: m[1].trim() };
  });
}

function newestAccepted(dir, task) {
  let best = null;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const m = /^T-(\d+)\.json$/.exec(name);
    if (!m || name === `${task}.json`) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
    if (!data || typeof data !== "object" || !data.acceptedAt) continue;
    if (!best || Number(m[1]) > best.n) best = { n: Number(m[1]), file: path.join(dir, name), data };
  }
  return best;
}

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** Every required key present, with the JSON type the accepted example uses. */
function validateShape(manifest, example) {
  const label = path.basename(example.file);
  for (const key of REQUIRED) {
    if (!(key in example.data)) refuse(`example ${label} lacks "${key}"; cannot learn its type`);
    if (!(key in manifest)) refuse(`manifest is missing "${key}"`);
    const want = typeOf(example.data[key]), got = typeOf(manifest[key]);
    // An example's `null` (expires_at) stands for "a string or null".
    const ok = want === "null" ? got === "null" || got === "string" : got === want;
    if (!ok) refuse(`"${key}" is ${got}, the accepted example ${label} has ${want}`);
    if (want === "array" && example.data[key].length > 0) {
      const el = typeOf(example.data[key][0]);
      const bad = manifest[key].find((v) => typeOf(v) !== el);
      if (bad !== undefined) refuse(`"${key}" holds a ${typeOf(bad)}, the accepted example ${label} holds ${el}`);
    }
  }
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    refuse(`could not write ${file}: ${error.message}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const brief = args.brief === undefined ? {} : briefHeader(fs.readFileSync(args.brief === "-" ? 0 : args.brief, "utf8"));
  const pick = (flag, key) => (args[flag] !== undefined ? args[flag] : brief[key]);

  const task = args.task || refuse("--task is required");
  const role = args.role || refuse("--role is required");
  const risk = args.risk;
  if (!risk) refuse("--risk must be passed explicitly (R0, R1 or R2)");
  if (!["R0", "R1", "R2"].includes(risk)) refuse(`--risk ${JSON.stringify(risk)} is not R0, R1 or R2`);
  const cancelHow = (args["cancel-how"] ?? "").trim() || refuse("--cancel-how must be passed; the dispatcher does not invent it");

  const base = pick("base", "base");
  if (!base || !/^[0-9a-f]{40}$/i.test(base.split(/\s/)[0])) refuse(`cannot derive base: need a 40-hex sha, got ${JSON.stringify(base ?? null)}`);
  const lane = (pick("lane", "lane") ?? "").split(/\s/)[0] || refuse("cannot derive lane: pass --lane or a `lane:` brief line");
  const writeScope = pick("write-scope", "write_scope");
  if (writeScope === undefined) refuse("cannot derive write_scope: pass --write-scope or a `write_scope:` brief line");
  const forbidden = pick("forbidden", "forbidden");
  if (forbidden === undefined) refuse("cannot derive forbidden: pass --forbidden or a `forbidden:` brief line");
  const acceptanceText = pick("acceptance", "acceptance");
  if (!acceptanceText) refuse("cannot derive acceptance: pass --acceptance or an `acceptance:` brief line");
  const acceptance = parseAcceptance(acceptanceText);
  if (!Array.isArray(acceptance) || acceptance.length === 0) refuse("acceptance is empty");
  const allowed = pick("allowed-commands", "allowed_commands");

  const expires = args.expires ?? null;
  if (expires !== null && (!/^\d{4}-\d{2}-\d{2}T/.test(expires) || Number.isNaN(Date.parse(expires)))) {
    refuse(`--expires ${JSON.stringify(expires)} is not an ISO timestamp`);
  }
  if (expires === null && acceptance.some((a) => a && a.kind === "external")) {
    refuse("acceptance has kind: external but no --expires <ISO>; the leg could stay BLOCKED forever");
  }

  let manifest = {
    task_id: task,
    lane,
    risk,
    base: base.split(/\s/)[0],
    write_scope: list(writeScope, ","),
    forbidden: list(forbidden, ","),
    ops_actions: [],
    acceptance,
    tier: role === "junior-a" || role === "junior-b" ? "junior" : "senior",
    p0_or_p1: "P0",
    brief_kind: role.startsWith("review-") ? "review" : "delivery",
    expires_at: expires,
    cancel_how: cancelHow,
    allowed_commands: allowed === undefined ? [] : list(allowed, " | "),
    reference: [],
  };
  if (args.overrides !== undefined) {
    let extra;
    try { extra = JSON.parse(args.overrides); } catch (error) { refuse(`--overrides is not valid JSON: ${error.message}`); }
    if (typeOf(extra) !== "object") refuse("--overrides must be a JSON object");
    if ("task_id" in extra && extra.task_id !== task) refuse("--overrides may not change task_id");
    manifest = { ...manifest, ...extra };
  }

  const tasksDir = args["tasks-dir"] ?? path.join(__dirname, "..", "checks", "tasks");
  const example = newestAccepted(tasksDir, task);
  if (!example) refuse(`no accepted manifest in ${tasksDir} to learn the shape from`);
  validateShape(manifest, example);

  const text = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.out) writeAtomic(args.out, text);
  process.stdout.write(text);
}

main();
