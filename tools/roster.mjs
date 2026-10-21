#!/usr/bin/env node
// Resolve a worker to provider/model/thinking through the owner's roster.
//
// Two layers, on purpose:
//   control/roster.json  — WHO may be dispatched. Its `profiles` list must equal the daemon config's
//                          `agentProfiles` exactly: no invented role, no unlisted profile.
//   daemon config        — WHAT each profile runs (provider, model, thinking). The owner's file, not ours.
// A role is a profile name. `routing` is documentation of which profile suits which kind of work, and every
// value in it must be a profile that exists — checked by checks/leg21-roster.cjs.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function readRoster(repoRoot) {
  return JSON.parse(readFileSync(join(repoRoot, "control/roster.json"), "utf8"));
}

/** The daemon config that holds agentProfiles. PASEO_HOME wins; then ~/code/paseo/.dev/paseo-home. */
export function configPath(env = process.env) {
  const home = env.PASEO_HOME || join(homedir(), "code", "paseo", ".dev", "paseo-home");
  return join(home, "config.json");
}

export function readProfiles(path = configPath()) {
  if (!existsSync(path)) return null;
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  const list = cfg?.daemon?.agentProfiles ?? [];
  return Array.isArray(list) ? list : [];
}

/**
 * role (a profile name) -> { role, provider, model, thinking }.
 * Throws when the role is not on the owner's list, or is on the list but absent from the daemon config.
 * There is no default: a missing profile must stop the dispatch.
 */
export function resolveRole(role, { repoRoot, profiles } = {}) {
  const roster = readRoster(repoRoot ?? process.cwd());
  const allowed = roster.profiles ?? [];
  if (!allowed.includes(role)) {
    throw new Error(`"${role}" is not on the roster (have: ${allowed.join(", ")})`);
  }
  const list = profiles ?? readProfiles();
  if (!list) throw new Error(`no daemon config at ${configPath()} — cannot resolve "${role}"`);
  const profile = list.find((p) => p?.name === role);
  if (!profile) {
    throw new Error(`"${role}" is on the roster but not in the daemon config (have: ${list.map((p) => p.name).join(", ")})`);
  }
  if (!profile.provider || !profile.model) throw new Error(`profile "${role}" names no provider/model`);
  return {
    role,
    profile: role,
    provider: String(profile.provider),
    model: String(profile.model),
    thinking: profile.thinking ? String(profile.thinking) : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = resolveRole(process.argv[2], { repoRoot: process.argv[3] ?? process.cwd() });
    // JSON, not tabs: an empty thinking field made `IFS=$'\t' read` collapse the columns and pass the profile
    // name as `--thinking` (2026-10-20, T-117 died on "Invalid value: 'review-codex'").
    process.stdout.write(JSON.stringify(r) + "\n");
  } catch (error) {
    process.stderr.write(`roster: ${error.message}\n`);
    process.exit(2);
  }
}
