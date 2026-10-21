#!/usr/bin/env node
// Record one dispatch grant. Called by tools/dispatch.sh before the agent exists.
//
// This is deliberately a separate, dependency-free implementation: the dispatcher runs in bash and cannot import
// TypeScript. `checks/leg47-grants.cjs` asserts that a record written here is read back by `readGrants()` and matched
// by `grantFor()`, so the two implementations cannot drift apart silently.
const { readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const { dirname, join, normalize, basename } = require("node:path");
const { homedir } = require("node:os");

const TTL = 7 * 24 * 60 * 60 * 1000;
const path = process.env.PASEO_STEWARD_GRANTS || join(homedir(), ".paseo-steward-grants.json");
const positional = [];
const flags = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--token" || argv[index] === "--locks") flags[argv[index].slice(2)] = argv[(index += 1)];
  else positional.push(argv[index]);
}
const [task, role, profile, provider, cwd, atInput] = positional;
// The token is the dispatch's reservation token; the dispatcher writes the same value to `<worktree>/.steward-grant`.
// A grant without one could only ever match its exact path, so the dispatcher must always supply it.
if (!task || !role || !profile || !provider || !cwd || !flags.token) {
  console.error("usage: grant.cjs <task> <review|implement> <profile> <provider> <cwd> [at] --token <token> [--locks <dir>]");
  process.exit(2);
}
if (role !== "review" && role !== "implement") {
  console.error(`grant.cjs: unknown role ${role}`);
  process.exit(2);
}
const at = atInput || new Date().toISOString();
const now = Date.parse(at);

let grants = [];
try {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (Array.isArray(parsed?.grants)) grants = parsed.grants;
} catch {
  grants = [];
}

const norm = (p) => normalize(p).replace(/\/+$/, "") || "/";
const kept = grants.filter((grant) => {
  if (!grant || typeof grant.cwd !== "string") return false;
  if (norm(grant.cwd) === norm(cwd)) return false;
  if (basename(norm(grant.cwd)) === basename(norm(cwd))) return false;
  const recordedAt = Date.parse(grant.at);
  return !(Number.isFinite(recordedAt) && Number.isFinite(now) && now - recordedAt > TTL);
});

mkdirSync(dirname(path), { recursive: true });
const grant = { task, role, profile, provider, cwd, at, token: flags.token, ...(flags.locks ? { locks: flags.locks } : {}) };
writeFileSync(path, `${JSON.stringify({ grants: [...kept, grant] }, null, 2)}\n`);
console.log(`grant ${task} ${role} ${provider} -> ${cwd}`);
