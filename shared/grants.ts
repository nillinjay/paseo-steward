import { z } from "zod";

/**
 * V1.2 phase 1 — a dispatch grant.
 *
 * The lesson behind this file: judging one shell command at a time cannot be made safe (five review rounds, 13
 * findings). So the steward stops answering commands and starts stating, once per leg, the environment the leg runs
 * in. Each provider turns that statement into its own native sandbox, and the command pop-ups disappear because the
 * CLI no longer needs to ask.
 *
 * Two rules keep this honest:
 *  - **Narrowing only.** No branch below ever widens what a provider does by default; every branch either sets a
 *    read-only/workspace-write sandbox or reduces what may be asked.
 *  - **A grant is looked up, never inferred.** The caller matches an exact worktree path that the dispatcher
 *    created, or a worktree that holds the grant's token. A title, a prompt or a string that merely contains `T-xxx`
 *    is not a grant.
 */
export const GrantRoleSchema = z.enum(["review", "implement"]);
export type GrantRole = z.infer<typeof GrantRoleSchema>;

export const GrantSchema = z.object({
  task: z.string().min(1),
  role: GrantRoleSchema,
  /** The daemon profile that was dispatched, kept for the report and for the surface. */
  profile: z.string().min(1),
  provider: z.string().min(1),
  /** Absolute worktree path. The lookup key. */
  cwd: z.string().min(1),
  at: z.string().min(1),
  /**
   * The dispatch's reservation token. The dispatcher also writes it to `<worktree>/.steward-grant`, and a worktree
   * found by name alone must hold it. Optional only so records written before V12-04 still parse; such a record can
   * match its exact path and nothing else.
   */
  token: z.string().min(1).optional(),
  /**
   * The dispatcher's `.locks` directory. `<locks>/<task>.json` holds the commands this dispatch declared, snapshotted
   * before the worker existed; the worker's own manifest is never read for that (V12-05).
   */
  locks: z.string().min(1).optional(),
});
export type Grant = z.infer<typeof GrantSchema>;

export const GrantsFileSchema = z.object({ grants: z.array(GrantSchema).default([]) });
export type GrantsFile = z.infer<typeof GrantsFileSchema>;

/** A grant older than this is not a grant for today's work; the worktree may have been reused. */
export const GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Clock skew tolerated for a grant stamped "in the future". Anything further ahead is not a grant. */
export const GRANT_SKEW_MS = 5 * 60 * 1000;

/** The file the dispatcher writes inside a worktree it created: one line, the grant's token. */
export const GRANT_TOKEN_FILE = ".steward-grant";

/**
 * Trailing slashes and stray `.` segments must not make two spellings of one worktree look like two different legs.
 * String-only on purpose: `shared/` may import neither the client nor the Node runtime.
 */
export function normalizeCwd(cwd: string): string {
  const parts: string[] = [];
  for (const part of cwd.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function baseName(cwd: string): string {
  const normalized = normalizeCwd(cwd);
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function underHome(home: string, name: string): string {
  return `${home.replace(/\/+$/, "")}/${name}`;
}

/**
 * The grant for `cwd`, or null. `readToken` returns the token in `<cwd>/.steward-grant` (null when absent); it is a
 * parameter because `shared/` may not touch the filesystem.
 */
export function grantFor(
  grants: readonly Grant[],
  cwd: string,
  readToken: (cwd: string) => string | null = () => null,
  now = Date.now(),
): Grant | null {
  const wanted = normalizeCwd(cwd);
  const wantedSlug = baseName(wanted);
  let token: string | null | undefined;
  for (let index = grants.length - 1; index >= 0; index -= 1) {
    const grant = grants[index]!;
    const recorded = normalizeCwd(grant.cwd);
    if (recorded !== wanted) {
      // A name is something anyone can choose: `/tmp/anything/paseo-t-100` has the same final segment as the real
      // worktree (V12-04). A worktree found by name must also hold the token the dispatcher wrote into it.
      if (!wantedSlug.startsWith("paseo-") || baseName(recorded) !== wantedSlug || !grant.token) continue;
      if (token === undefined) token = readToken(wanted);
      if (token !== grant.token) continue;
    }
    const at = Date.parse(grant.at);
    if (!Number.isFinite(at) || at - now > GRANT_SKEW_MS || now - at > GRANT_TTL_MS) return null;
    return grant;
  }
  return null;
}

/** `claude-sbx/claude-opus-5-5` -> `claude-sbx`: the registered provider id, without the model. */
export function providerId(provider: string): string {
  return provider.trim().toLowerCase().split("/")[0]!;
}

/** The providers whose launch command is our own bubblewrap wrapper. Named exactly: a pattern is not a proof. */
export const SANDBOXED_PROVIDERS: readonly string[] = ["claude-sbx", "opencode-sbx"];

export interface ProviderOptionRecord {
  [key: string]: unknown;
}

/**
 * The provider's native options for one role. `null` means "this plugin has nothing to say about this provider",
 * and the caller must leave the request untouched — silence is the safe default.
 */
export function grantOptions(
  provider: string,
  role: GrantRole,
  cwd: string,
  home: string,
  /**
   * Directories the leg must also be able to write. A linked worktree keeps its git metadata in the MAIN repository
   * (`.git/worktrees/<name>`), so a sandbox that allows only the worktree cannot commit -- the codex worker found
   * exactly that on 2026-10-21 ("git metadata is read-only, commit failed"). Committing is the deliverable, so the
   * git directories are part of the leg's own territory.
   */
  extraWritable: readonly string[] = [],
  /**
   * Exact command lines this leg declared it will run. OpenCode has a permission map keyed by command pattern, so a
   * declared command can be allowed by name while everything else still asks. This is a lookup in a list the
   * dispatcher snapshotted before the worker existed -- not a judgement about whether a command looks dangerous.
   */
  declaredCommands: readonly string[] = [],
): ProviderOptionRecord | null {
  const name = provider.toLowerCase();
  const sandboxed = SANDBOXED_PROVIDERS.includes(providerId(provider));
  const secrets = [underHome(home, ".ssh"), underHome(home, ".aws"), underHome(home, ".config/gh")];
  const worktree = normalizeCwd(cwd);
  // Both roles must be able to write exactly one thing: implementers write code, reviewers write a verdict. A
  // read-only sandbox would block the artifact the gate requires, so the write boundary is the worktree either way,
  // and what narrows a reviewer is `web_search: disabled` plus the gate's write-scope check.
  if (name.includes("codex")) {
    return {
      approval_policy: "never",
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: {
        writable_roots: [worktree, ...extraWritable.map(normalizeCwd)],
        network_access: false,
        // A leg needs scratch: 29 checks failed inside the first sandbox because `/tmp` was read-only (T-168's worker
        // reported EROFS). `/tmp` is not part of any deliverable -- the gate reads the committed diff -- so allowing
        // it costs nothing the gate checks.
        exclude_slash_tmp: false,
      },
      ...(role === "review" ? { web_search: "disabled" as const } : {}),
    };
  }
  if (name.includes("opencode")) {
    return {
      permission: {
        read: "allow",
        edit: "allow",
        external_directory: "deny",
        webfetch: role === "review" ? "deny" : "deny",
        // Paseo runs ONE shared OpenCode server per machine with a neutral cwd, so a per-leg OS sandbox cannot be
        // bound to it (measured 2026-10-21). Containment therefore comes from the tool layer: no shell except the
        // exact commands this leg declared, and no path outside the worktree at all.
        // A provider that is already inside bubblewrap needs no command-by-command answer: the kernel refuses anything
        // outside the Paseo home, so an allowed shell cannot reach the machine's files.
        bash: sandboxed ? ("allow" as const)
          : declaredCommands.length > 0
          ? Object.fromEntries([...declaredCommands.map((cmd) => [cmd, "allow" as const]), ["*", "ask" as const]])
          : "ask",
        ...(role === "review" ? { websearch: "deny" as const, codesearch: "deny" as const } : {}),
      },
    };
  }
  if (name.includes("claude")) {
    // A provider whose launch command is already bubblewrap must NOT ask Claude Code to sandbox again: the inner
    // bwrap cannot create a second user namespace under the outer one, and every Bash call fails with
    // "bwrap: No permissions to create new namespace" (T-172, 2026-10-21). One sandbox, not two.
    if (sandboxed) return { settings: { sandbox: { enabled: false } } };
    return {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        // The one automatic approval in V1.2, and it is sound only because the provider enforces the sandbox: a
        // command that cannot reach anything outside the worktree has nothing left to approve.
        autoAllowBashIfSandboxed: true,
        filesystem: { allowWrite: [worktree, ...extraWritable.map(normalizeCwd)], denyRead: secrets },
      },
    };
  }
  return null;
}
