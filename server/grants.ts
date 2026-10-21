import type { PluginServerContext } from "@getpaseo/plugin/server";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { mkdirSync } from "node:fs";
import {
  GRANT_TOKEN_FILE,
  GRANT_TTL_MS,
  GrantsFileSchema,
  grantFor,
  grantOptions,
  normalizeCwd,
  providerId,
  type Grant,
} from "../shared/grants";

/**
 * The dispatch registry, outside the repository on purpose: a worker writes inside its worktree, so it cannot forge
 * the record that decides how its own session is sandboxed. `PASEO_STEWARD_GRANTS` exists so checks can point at a
 * temporary file.
 */
export function grantsPath(): string {
  return process.env.PASEO_STEWARD_GRANTS ?? join(homedir(), ".paseo-steward-grants.json");
}

export function readGrants(): Grant[] {
  try {
    const parsed = GrantsFileSchema.safeParse(JSON.parse(readFileSync(grantsPath(), "utf8")));
    return parsed.success ? parsed.data.grants : [];
  } catch {
    return [];
  }
}

/** Record one grant per worktree: dispatching the same worktree twice must not pile up contradictory records. */
export function writeGrant(grant: Grant): void {
  const path = grantsPath();
  const now = Date.parse(grant.at);
  const kept = readGrants().filter((existing) => {
    if (normalizeCwd(existing.cwd) === normalizeCwd(grant.cwd)) return false;
    const at = Date.parse(existing.at);
    return !(Number.isFinite(at) && Number.isFinite(now) && now - at > GRANT_TTL_MS);
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ grants: [...kept, grant] }, null, 2)}\n`);
}

function paseoHome(): string {
  return process.env.PASEO_HOME ?? join(homedir(), ".paseo");
}

function realOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return normalizeCwd(path);
  }
}

function contains(outer: string, inner: string): boolean {
  return inner === outer || inner.startsWith(`${outer.replace(/\/+$/, "")}/`);
}

/**
 * The directories a worktree's git metadata claim may make writable: `[<repo>/.git/worktrees/<name>, <repo>/.git]`,
 * or nothing. The claim comes from `.git`/`commondir`, which the worker can rewrite, and `gitdir: /` once made the
 * whole machine writable (V12-01). So it must resolve to an existing `<repo>/.git/worktrees/<name>` whose
 * `<repo>/.git` exists, and neither directory may be `/` or contain the worktree or the Paseo home. Same rule as
 * `git_meta_roots` in both sandbox wrappers.
 */
export function gitMetadataRoots(claim: string, worktree: string, home = paseoHome()): string[] {
  if (!isAbsolute(claim)) return [];
  let meta: string;
  try {
    meta = realpathSync(claim);
    if (!statSync(meta).isDirectory()) return [];
  } catch {
    return [];
  }
  const dotgit = dirname(dirname(meta));
  if (basename(dirname(meta)) !== "worktrees" || basename(dotgit) !== ".git") return [];
  try {
    if (!statSync(dotgit).isDirectory()) return [];
  } catch {
    return [];
  }
  for (const guarded of [realOr(worktree), realOr(home)]) {
    if (contains(meta, guarded) || contains(dotgit, guarded)) return [];
  }
  return [meta, dotgit];
}

/** The git metadata a worktree needs before it can commit. Empty when git cannot answer; the caller then adds none. */
export function gitWritableRoots(cwd: string, home = paseoHome()): string[] {
  let gitDir: string;
  try {
    gitDir = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return [];
  }
  if (!gitDir) return [];
  // An ordinary repository keeps its metadata inside the worktree, which is writable already.
  if (gitDir !== "/" && contains(realOr(cwd), realOr(gitDir))) return [gitDir];
  const roots = gitMetadataRoots(gitDir, cwd, home);
  if (roots.length === 0) {
    console.log(`[paseo-steward] not granting git metadata outside ${cwd}: ${gitDir} is not <repo>/.git/worktrees/<name>`);
  }
  return roots;
}

/**
 * The exact commands a leg declared, from the dispatcher's own `<locks>/<task>.json` -- outside every worktree, and
 * only when its token is this grant's token. The manifest inside the worktree is the worker's to edit, so it is never
 * authority for the shell (V12-05); the gate still reads `allowed_commands` from the steward's manifest. An entry
 * containing a wildcard is dropped rather than trusted, because a pattern is exactly what five review rounds defeated.
 */
export function declaredCommands(locks: string | undefined, task: string, token: string | undefined): string[] {
  if (!locks || !token) return [];
  try {
    const raw = JSON.parse(readFileSync(join(locks, `${task}.json`), "utf8")) as {
      allowed_commands?: unknown;
      token?: unknown;
    };
    if (raw.token !== token || !Array.isArray(raw.allowed_commands)) return [];
    return raw.allowed_commands
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .filter((entry) => !/[*?$`]/.test(entry))
      .map((entry) => entry.trim().replace(/\s+/g, " "));
  } catch {
    return [];
  }
}

/** The token the dispatcher wrote into a worktree it created, or null. */
export function worktreeToken(cwd: string): string | null {
  try {
    const token = readFileSync(join(cwd, GRANT_TOKEN_FILE), "utf8").split("\n")[0]!.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

interface CreateRequest {
  config?: { cwd?: string; provider?: string; modeId?: string; providerOptions?: Record<string, unknown> };
}

/**
 * `agent.create` runs before the provider session starts, so the options set here are the ones the CLI launches with.
 * When no grant matches, the request is returned untouched: the owner's own sessions and any hand-started agent keep
 * exactly the behaviour they had.
 */
export function applyGrant(request: CreateRequest, home: string, grants: readonly Grant[]): CreateRequest {
  const config = request.config;
  if (!config?.cwd) return request;
  const grant = grantFor(grants, config.cwd, worktreeToken);
  if (!grant) return request;
  // The grant names the provider the dispatcher launched. A request for any other provider is not this dispatch, and
  // gets nothing: `claude-sbx-plain` once matched a `claude...sbx` pattern and got bypass mode (V12-06).
  const provider = config.provider ?? grant.provider;
  if (providerId(provider) !== providerId(grant.provider)) return request;
  const options = grantOptions(
    provider,
    grant.role,
    config.cwd,
    home,
    gitWritableRoots(config.cwd),
    declaredCommands(grant.locks, grant.task, grant.token),
  );
  if (!options) return request;
  // A provider whose launch command already runs inside bubblewrap needs no further prompt: the sandbox is enforced
  // below the tool layer, so `bypassPermissions` removes clicks without removing containment. Only `claude-sbx`, by
  // equality, gets this; every other claude leg keeps whatever mode the profile chose.
  // `bypassPermissions` is a Claude mode. Another provider that happens to be sandboxed keeps its own modes.
  const sandboxed = providerId(provider) === "claude-sbx";
  const mode = sandboxed && (config.modeId === undefined || config.modeId === "default" || config.modeId === "auto")
    ? "bypassPermissions"
    : config.modeId;
  return {
    ...request,
    config: {
      ...config,
      ...(mode === undefined ? {} : { modeId: mode }),
      providerOptions: { ...(config.providerOptions ?? {}), ...options },
    },
  };
}

export function registerGrants(server: PluginServerContext, home = homedir()): () => void {
  return server.before("agent.create", ({ request }) => {
    try {
      return applyGrant(request as CreateRequest, home, readGrants()) as typeof request;
    } catch (error) {
      // A grant that cannot be read must not block an agent from starting; it must also never be invented.
      console.log(`[paseo-steward] grant hook skipped: ${error instanceof Error ? error.message : String(error)}`);
      return request;
    }
  });
}
