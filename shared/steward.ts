import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Lease ids may be seven-character prefixes. Presence and delivery must use the same match. */
export function agentIdMatches(left: string, right: string): boolean {
  const valid = /^[0-9a-f]{7,}(?:-[0-9a-f]+)*$/i;
  if (!valid.test(left) || !valid.test(right)) return false;
  const a = left.toLowerCase(), b = right.toLowerCase();
  return a.startsWith(b) || b.startsWith(a);
}

// ---------------------------------------------------------------- Manifest (DESIGN-V2 §15.1–§15.5)

/**
 * Which kind of work a brief asks for. Without this field a delivery and an analysis look identical to a
 * successor, so it cannot choose the terminal outcome or know that "no anomaly" is a result (R4).
 */
export const BriefKindSchema = z.enum([
  "delivery",
  "reproduction",
  "information",
  "analysis",
  "audit",
  "incident",
]);
export type BriefKind = z.infer<typeof BriefKindSchema>;

/**
 * A non-git mutation the brief authorises: a service restart, a config change, a runbook step. Gate 0 sees
 * only `git diff`, so these must be declared or the most destructive action of a task is invisible (R6).
 */
export const OpsActionSchema = z.object({
  cmd: z.string().min(1),
  reversible: z.boolean(),
  /** Owner confirmation id. Required when `reversible` is false (§15.2, §15.5). */
  owner_ack_id: z.string().min(1).optional(),
});
export type OpsAction = z.infer<typeof OpsActionSchema>;

/**
 * A numeric claim. §15.4 rule 1: a KPI without numerator/denominator, window and truncation rule is two
 * different numbers in two people's hands. All four parts are therefore required.
 */
export const NumericPredicateSchema = z.object({
  metric: z.string().min(1),
  op: z.enum(["<", "<=", ">", ">=", "==", "!="]),
  value: z.number(),
  unit: z.string().optional(),
  /** The measurement window, e.g. `2026-10-13..2026-10-20` or `7d`. */
  window: z.string().min(1),
  /** Numerator / denominator, in words a successor can recompute. */
  definition: z.string().min(1),
  /** Truncation / exclusion rule. `none` is explicit. */
  truncation: z.string().min(1),
});
export type NumericPredicate = z.infer<typeof NumericPredicateSchema>;

/**
 * §15.1: acceptance is no longer only "a command exited 0". A measurement binds a number; an external
 * acceptance names the party whose credential defines DONE.
 */
export const AcceptanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cmd"), cmd: z.string().min(1) }),
  z.object({ kind: z.literal("measurement"), cmd: z.string().min(1), predicate: NumericPredicateSchema }),
  z.object({ kind: z.literal("external"), party: z.string().min(1) }),
]);
export type Acceptance = z.infer<typeof AcceptanceSchema>;

const BASE_SHA = z.string().regex(/^[0-9a-f]{40}$/i, "base must be a full 40-hex sha, never HEAD or a branch");

/**
 * The complete task Manifest. The schema enforces the three §15.4 rules it can see, plus the §15.5
 * incident requirements. It does not run a gate; the Guard does that.
 */
export const ManifestSchema = z
  .object({
    task_id: z.string().min(1),
    lane: z.enum(["fast", "standard", "parallel"]),
    tier: z.enum(["junior", "senior"]),
    profile: z.string().min(1).optional(),
    risk: z.enum(["R0", "R1", "R2"]),
    /** §15.1. Chooses the terminal outcome. */
    brief_kind: BriefKindSchema,
    /** §15.4 rule 3: a 40-hex sha, not HEAD, whenever the artifact leaves the project. */
    base: BASE_SHA,
    write_scope: z.array(z.string()),
    forbidden: z.array(z.string()).default([]),
    /** §15.1. `[]` when the task makes no non-git mutation. */
    ops_actions: z.array(OpsActionSchema).default([]),
    /**
     * V1.2: the exact command lines this leg may run without asking. A list, not a pattern: an entry containing a
     * wildcard or a substitution is refused, because a pattern is what five review rounds defeated. Providers that
     * have a permission map (OpenCode) turn this into named allows; providers with an OS sandbox ignore it.
     */
    allowed_commands: z.array(z.string().min(1)).default([]),
    acceptance: z.array(AcceptanceSchema).min(1),
    /** §15.1. ISO deadline for a third-party dependency; `null` when none. */
    expires_at: z.string().min(1).nullable(),
    /** §15.5. Incident only: the closed set of commands the worker may run. */
    runbook: z.string().min(1).optional(),
    p0_or_p1: z.enum(["P0", "P1"]),
    /** §15.4 rule 2: must not discard committed evidence. Evidence-losing work is P0 or `never`. */
    cancel_how: z.string().min(1),
    reference: z.array(z.string()).default([]),
  })
  .superRefine((manifest, ctx) => {
    manifest.allowed_commands.forEach((cmd, index) => {
      if (/[*?$`]/.test(cmd)) {
        ctx.addIssue({
          code: "custom",
          path: ["allowed_commands", index],
          message: "a declared command is a literal line, not a pattern",
        });
      }
    });
    manifest.ops_actions.forEach((action, index) => {
      if (!action.reversible && !action.owner_ack_id) {
        ctx.addIssue({
          code: "custom",
          path: ["ops_actions", index, "owner_ack_id"],
          message: "an irreversible ops action needs the owner confirmation id",
        });
      }
    });
    if (manifest.acceptance.some((item) => item.kind === "external") && manifest.expires_at === null) {
      ctx.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "an external acceptance needs an ISO expires_at so the leg cannot stay BLOCKED forever",
      });
    }
    if (manifest.brief_kind === "incident" && !manifest.runbook) {
      ctx.addIssue({
        code: "custom",
        path: ["runbook"],
        message: "an incident brief runs only commands named in its runbook",
      });
    }
  });
export type Manifest = z.infer<typeof ManifestSchema>;

/** Fields every dispatched brief must carry, in template order. Used by the acceptance probe. */
export const REQUIRED_MANIFEST_FIELDS = [
  "task_id",
  "lane",
  "tier",
  "risk",
  "brief_kind",
  "base",
  "write_scope",
  "forbidden",
  "ops_actions",
  "acceptance",
  "expires_at",
  "p0_or_p1",
  "cancel_how",
  "reference",
] as const;

/** §15.3. Five terminal outcomes; `DONE` is no longer the only successful one. */
export const TERMINAL_OUTCOMES = [
  "DONE",
  "NO-ANOMALY",
  "CLOSED-DISCARDED",
  "SOURCE_UNAVAILABLE",
  "EXTERNAL_ACCEPTANCE",
] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/** §15.5. Shell auto-approval never covers these verbs; the protocol carries the same list. */
export const DESTRUCTIVE_VERB_DENYLIST = ["rm -rf", "DROP", "reset --hard", "push --force"] as const;

/** One row of control/COMMAND.md's dispatch ledger. */
export const DispatchRowSchema = z.looseObject({
  leg: z.string(),
  workspace: z.string(),
  branch: z.string(),
  employee: z.string(),
  status: z.string(),
  gate: z.string(),
  updated: z.string(),
  /** True when `status` reads as finished-and-mergeable. */
  done: z.boolean(),
  /**
   * HISTORICAL FLAG. True when this row's `status` text reads as blocked/stopped. Rows are not always
   * rewritten when the problem is resolved by a later row, so this is the RECORD's word, not an open
   * problem. Never count it; it is only used to exclude a row from the record's in-flight view.
   */
  blockedInRecord: z.boolean(),
});

export const MergeRowSchema = z.looseObject({
  at: z.string(),
  branch: z.string(),
  leg: z.string(),
  gate: z.string(),
  commit: z.string(),
});

/**
 * G12: acceptance is read from the artifact, never inferred from a sentence. One row per task in
 * `checks/tasks/`, whether or not an artifact exists yet. `artifactExists: false` is the honest
 * `implemented, unverified` state — it is not an error and it is not acceptance.
 */
export const AcceptanceStatusSchema = z.looseObject({
  task: z.string(),
  /** Repo-relative path of the chosen artifact, or null when the task has none. */
  artifactPath: z.string().nullable(),
  artifactExists: z.boolean(),
  /** The commit the artifact records. */
  sha: z.string().nullable(),
  /** True only when `sha` equals the project's current HEAD. Null when HEAD is unreadable. */
  commitMatchesHead: z.boolean().nullable(),
  /** True only when at least one command was recorded and every one exited 0. */
  allCommandsPassed: z.boolean(),
  commandCount: z.number(),
  verdict: z.string().nullable(),
  /**
   * The one word a human should read. `legacy-accepted` recovers an acceptance whose artifact our own process
   * lost; `legacy-artifact` marks evidence written before the aggregate verdict existed. Neither is a claim.
   */
  status: z.enum(["certified", "legacy-accepted", "legacy-artifact", "unverified", "failed"]).optional(),
  note: z.string().optional(),
});

export const WorkspaceSchema = z.looseObject({
  project: z.string(),
  id: z.string(),
  name: z.string(),
  isolation: z.string(),
  cwd: z.string(),
  /** True when this workspace looks like a steward shell for the project dir. */
  stewardLike: z.boolean(),
});

/**
 * One agent the daemon reports as `running` NOW (`paseo agent ls -g --json`), in a workspace of this
 * project. This, not the dispatch ledger, is the source of every "running" number.
 */
export const LiveAgentSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  provider: z.string(),
  /** Absolute working directory, `~` expanded. */
  cwd: z.string(),
  /** The project workspace whose `cwd` this agent runs in. */
  workspaceId: z.string(),
});

export const FailureRecordSchema = z.object({
  fingerprint: z.string(),
  code: z.enum(["E_LOGIC", "E_ENV", "E_FLAKY", "E_UNKNOWN"]),
  at: z.string(),
});
export type FailureRecord = z.infer<typeof FailureRecordSchema>;

/** Input order is report order. Environment/permission waits break a logic streak. */
export function strikeOutcome(prior: FailureRecord[], next: FailureRecord): { strikes: number; escalate: boolean; reason: string } {
  if (next.code === "E_ENV" || next.code === "E_FLAKY")
    return { strikes: 0, escalate: false, reason: `${next.code}: reset; no logic strike` };
  if (next.code === "E_UNKNOWN")
    return { strikes: 1, escalate: false, reason: "E_UNKNOWN counts once; never escalates" };
  let strikes = 1;
  for (let i = prior.length - 1; i >= 0; i--) {
    const previous = prior[i]!;
    if (previous.code !== "E_LOGIC" || previous.fingerprint !== next.fingerprint) break;
    strikes++;
  }
  return { strikes, escalate: strikes === 2,
    reason: strikes === 2 ? "Second consecutive E_LOGIC with the same fingerprint; senior takeover required" : "E_LOGIC: self-repair within the current task" };
}

const TaskFailureSchema = FailureRecordSchema.extend({
  task: z.string(),
  attempt: z.string(), worktree: z.string(), reportId: z.string(), commit: z.string(),
  strikes: z.number(), escalate: z.boolean(), reason: z.string(),
  disqualified: z.boolean(),
  escalation: z.object({ task: z.string(), attempt: z.string(), toProfile: z.string(),
    worktree: z.string(), at: z.string(), reason: z.string() }).optional(),
});

/** One project's steward. Each project gets its own row, keyed by its root directory. */
export const ProjectConfigSchema = z.looseObject({
  taskFailures: z.record(z.string(), z.array(TaskFailureSchema)).default({}),
  root: z.string(),
  /** The Paseo project id captured at onboarding. Empty when the folder is not registered. */
  paseoProject: z.string(),
  /** The ONE workspace this project's steward may run in. Empty until configured. */
  workspace: z.string(),
  provider: z.string(),
  thinking: z.string(),
  /**
   * The cheap tier, as `harness/model` — by default `opencode/opencode-go/deepseek-v4.1-flash`. Junior hands
   * run on the opencode harness; pi's harness is the steward's own. The capitalist rule: a leg a junior can do
   * must never go to a senior, and the slot-scan poke names this value so habit cannot reach for the expensive
   * model.
   */
  juniorProvider: z.string(),
  intervalMinutes: z.number(),
  /**
   * Implementation slots (owner ruling, 2026-10-20): **2**, not 5. Lite says prove the loop with two before
   * widening, and a slot is expensive. Read-only work (reviews, analysis) takes no slot.
   */
  maxConcurrent: z.number(),
  /** When the wheel may next start a steward. Persisted, so a plugin reload cannot reset the schedule. */
  nextTickAt: z.string().nullable(),
  /** The last automatic dispatch. Persisted, because the floor it protects must survive a reload. */
  lastDispatchAt: z.string().nullable(),
  /**
   * The last slot-scan poke and the facts it carried. Persisted for the same reason the dispatch floor is:
   * the plugin reloads constantly, and dedupe state that lives in the process is not dedupe.
   */
  lastPokeAt: z.string().nullable(),
  lastPokeFingerprint: z.string().nullable(),
  /**
   * Consecutive failed pokes against the currently claimed agent. Persisted for the same reason the floor
   * is: a listed but unresumable claim must not recover merely because the plugin reloaded. When it reaches
   * the policy limit the claim is void and 接管 may replace it, subject to the dispatch floor.
   */
  takeoverError: z.string().nullable().default(null),
  pokeFailureCount: z.number(),
  /** The claim the counter belongs to, so a new claim starts from zero. */
  pokeFailureAgent: z.string().nullable(),
  /** Completion notices stay here until a send succeeds, including across plugin reloads. */
  pendingWakes: z.array(z.object({ id: z.string(), line: z.string(), at: z.string() })).default([]),
  /**
   * 懒人模式. When on, supervision is unattended: a finished worker wakes the same steward session,
   * the steward re-runs the leg's acceptance, and it dispatches the next ready item. When off, nothing
   * happens automatically; the owner presses "立即交接". Only the four owner-only classes may stop it.
   */
  lazyMode: z.boolean(),
  enabled: z.boolean(),
  leaseStaleMinutes: z.number(),
  /** Policy a: answer `ExitPlanMode` (a plan request) with allow. Leaving plan mode grants nothing new. */
  autoAllowPlanExit: z.boolean(),
  /** Policy b: answer a question (`request_user_input_async`, `AskUserQuestion`) with deny + QUESTION_DENY_MESSAGE. */
  autoDenyQuestions: z.boolean(),
  /**
   * Policy c: answer a shell request (`CodexBash`, `Bash`, …) with allow. A worker that must ask a human for
   * every command cannot work unattended; this is what made 懒人模式 stall. Every answer is audited like any
   * other, and turning it off leaves shell requests pending for the human.
   */
  autoAllowShell: z.boolean(),
  /** Owner-declared test invocations as exact argv arrays; no prefix matching. */
  safeTestRunners: z.array(z.array(z.string()).min(1)).optional(),
  /**
   * Directories this project may READ without asking, beyond /tmp and the Paseo source. The use case is a
   * reference implementation: the torchfdtd project studies `/data/nil-home/FDTD/torchfdtd`, a different
   * checkout of the library it is reproducing, and a worker there had to stop for a human to read it.
   * Empty by default; every entry is an absolute path the owner approved.
   */
  readOnlyRoots: z.array(z.string().startsWith("/")).default([]),
});

/** How the policy reads a permission request. Only `plan` and `question` are ever answered automatically. */
export type RequestClass = "plan" | "question" | "shell" | "temp" | "source" | "external" | "blocked" | "edit" | "other";

/** The SDK kind is authoritative. A plan exit also needs its matching name; unknown stays pending. */
export function classifyRequest(name: string, kind?: string, detail?: string): RequestClass {
  if (kind === "question") return "question";
  if (kind === "plan" && (name === "ExitPlanMode" || name === "exit_plan_mode")) return "plan";
  // THE SDK KIND IS AUTHORITATIVE. A shell-shaped name with kind "plan" is a plan request that was named
  // `Bash`; matching on the name alone auto-allowed it and broke the invariant F1 established (independent
  // review of LEG 5, Finding 3, 2026-10-20). Only an explicit kind may be answered by the shell policy.
  if (kind === "plan" || kind === "question") return "other";
  // A shell command. Without this case, every codex worker stalls on its first `CodexBash` and the turn
  // never closes — measured 2026-10-19: two workers sat 25 minutes on one pending request each.
  // A worker has no browser and no desktop. On 2026-10-20 a worker invoked `chrome-use --session t113` to read
  // Paseo docs and opened real Chrome windows on the owner's screen. Deny, do not defer: a worker does not need
  // a human to decide whether it may open a window.
  if (/chrome-use|google-chrome|chromium|firefox|xdg-open|open -a/i.test(detail ?? "")) return "blocked";
  if (/bash|shell|exec|command/i.test(name)) return "shell";
  // A file edit. The PATH decides, and the caller must supply it: a write inside the worker's own worktree is
  // the work itself, a write outside it is a human decision. This case exists because the claude worker stalled
  // on `Edit client/strings.ts` — its own file, in its own write scope (2026-10-20).
  if (/^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create_file)/i.test(name)) return "edit";
  // An out-of-project path. Scratch under /tmp is not a decision; anything else is the human's.
  if (/external_directory/i.test(name)) {
    // EVERY requested path must be temporary. Matching "/tmp" anywhere in the text auto-allowed a request
    // that also granted /home/private/* (review F6). Absolute paths only, structured scopes first, `.`/`..`
    // resolved, and a scope we cannot parse is never granted: review N2 and the T-120 stall both lived here.
    const paths = scopePaths(detail);
    const normalized = paths.map(normalizeScopePath);
    if (normalized.some((p) => p === null)) return "external";
    const allTemp = normalized.length > 0 && normalized.every((p) => p === "/tmp" || p!.startsWith("/tmp/"));
    if (allTemp) return "temp";
    // Reading the Paseo source we are extending is documentation, not privilege: a worker implementing
    // `onboard` needs the CLI's own project commands. Only OUR tree, only when EVERY path is inside it.
    // The Paseo source tree is documentation, not privilege. It is a deployment detail, so it comes from the
    // environment; with no environment, no path earns the `source` class (it falls through to `external`).
    const PASEO_TREE = (process.env.PASEO_SOURCE_ROOT ?? "").replace(/\/*$/, "/");
    if (PASEO_TREE === "/") return "external";
    const allSource = normalized.length > 0 && normalized.every((p) => p!.startsWith(PASEO_TREE));
    return allSource ? "source" : "external";
  }
  return "other";
}

/** Conservative absolute scope grammar; ambiguous quoting or wildcard components stay pending. */
/**
 * The external paths a request names, normalized, or null when any of them is untrustworthy.
 * Kept as the server's entry point (it re-checks containment against the real filesystem); the parsing and
 * the `.`/`..` rule live in `scopePaths` / `normalizeScopePath` so one implementation answers both the
 * classification and the containment question.
 */
export function externalPaths(detail?: string): string[] | null {
  const paths = scopePaths(detail);
  if (!paths.length) return null;
  const normalized = paths.map(normalizeScopePath);
  return normalized.some((p) => p === null) ? null : (normalized as string[]);
}

/** The first file path named by a tool request, or null when the request names none. */
export function filePathFrom(detail: string | undefined): string | null {
  const text = detail ?? "";
  const m =
    text.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)"/) ??
    text.match(/"filePath"\s*:\s*"((?:[^"\\]|\\.)*)"/) ??
    text.match(/"path"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  try {
    return JSON.parse(`"${m[1]}"`) as string;
  } catch {
    return m[1];
  }
}

/**
 * Absolute paths named by a permission request. Structured `patterns` / `directories` win when present,
 * because a tool may describe its scope as a glob while its command text mentions unrelated paths.
 */
export function scopePaths(detail: string | undefined): string[] {
  const text = detail ?? "";
  const structured: string[] = [];
  for (const match of text.matchAll(/"(?:patterns|directories)"\s*:\s*\[([^\]]*)\]/g)) {
    for (const item of match[1]!.matchAll(/"([^"]+)"/g)) {
      if (item[1]!.startsWith("/")) structured.push(item[1]!);
    }
  }
  if (structured.length > 0) return structured;
  const out: string[] = [];
  const re = /(?:^|[\s"'\[(=,:])(\/[^\s"',;\])\x60]*)/g;
  for (const match of text.matchAll(re)) out.push(match[1]!);
  return out;
}

/**
 * Resolve `.` and `..`, drop a trailing glob, and return null when the path cannot be trusted.
 * `/tmp/../home/private/*` must not look temporary (review N2).
 */
export function normalizeScopePath(path: string): string | null {
  if (!path.startsWith("/")) return null;
  if (path.includes("\u0000")) return null;
  const globless = path.replace(/\/(\*\*|\*)$/, "");
  const parts: string[] = [];
  for (const part of globless.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return "/" + parts.join("/");
}

export const QUESTION_DENY_MESSAGE =
  "No operator is present. Do not wait for input: end your turn now and put the question in your final report; the steward batches questions for the owner.";

/** One AUTOMATIC answer the plugin gave. Nothing is answered without leaving one of these. */
export const PermissionAuditSchema = z.looseObject({
  /** One attempt, stable while its delivery and persistence states are updated. */
  attemptId: z.string().default(""),
  at: z.string(),
  project: z.string(),
  agentId: z.string(),
  agentTitle: z.string(),
  requestId: z.string(),
  /** Tool name as the provider sent it, e.g. `ExitPlanMode`, `request_user_input_async`. */
  request: z.string(),
  kind: z.enum(["plan", "question", "shell", "temp", "source", "external", "blocked", "edit"]),
  decision: z.enum(["allow", "deny"]),
  /** `event`: answered as it was raised. `sweep`: an already-pending request answered on demand. */
  source: z.enum(["event", "sweep"]),
  /** Prepared is durable intent, unconfirmed is a send call without proof, confirmed needs a fresh snapshot. */
  delivery: z.enum(["not-sent", "prepared", "unconfirmed", "confirmed", "failed", "legacy"]).default("legacy"),
  /** False for a recoverable runtime row whose latest state could not be saved. */
  recorded: z.boolean().default(true),
  ok: z.boolean(),
  error: z.string().nullable(),
});

/** One request pending NOW on an agent in this project's workspaces (`paseo permit ls`). */
export const PendingRequestSchema = z.looseObject({
  agentId: z.string(),
  agentName: z.string(),
  /** The agent's daemon status. `idle` + a pending request = a turn that will never close. */
  agentStatus: z.string(),
  requestId: z.string(),
  request: z.string(),
  /** The scope/description the CLI or SDK reported. Without it the sweep cannot classify /tmp or source paths. */
  description: z.string().default(""),
  kind: z.enum(["plan", "question", "shell", "temp", "source", "external", "blocked", "edit", "other"]),
});

/** Cheap per-project summary, for the sidebar and the project picker. */
export const ProjectSummarySchema = z.looseObject({
  root: z.string(),
  name: z.string(),
  onboarded: z.boolean(),
  workspace: z.string(),
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  /** Live workers: running agents in this project's workspaces, steward sessions excluded. */
  workersLive: z.number(),
  questions: z.number(),
  leaseState: z.string().nullable(),
  leaseStale: z.boolean().nullable(),
  warnings: z.number(),
});

export const ProjectsResultSchema = z.looseObject({
  schema: z.literal("paseo-steward/1"),
  generatedAt: z.string(),
  projects: z.array(ProjectSummarySchema),
  totals: z.looseObject({ workersLive: z.number(), questions: z.number(), warnings: z.number() }),
});

export const StewardStateSchema = z.looseObject({
  schema: z.literal("paseo-steward/1"),
  generatedAt: z.string(),
  clockUtc: z.string(),
  project: z.string(),
  /** False when the directory has no control/COMMAND.md: not managed by this protocol yet. */
  onboarded: z.boolean(),
  config: ProjectConfigSchema,
  projectExists: z.boolean(),
  git: z
    .looseObject({
      branch: z.string(),
      head: z.string(),
      dirtyFiles: z.number(),
      ahead: z.number(),
      behind: z.number(),
    })
    .nullable(),
  lease: z
    .looseObject({
      session: z.string(),
      paseoAgent: z.string(),
      since: z.string(),
      heartbeat: z.string(),
      state: z.string(),
      heartbeatAgeMinutes: z.number().nullable(),
      /** A heartbeat AFTER the clock is an error, not a fresh lease. */
      heartbeatInFuture: z.boolean(),
      stale: z.boolean(),
      /** The lease block names an agent id. This — not the heartbeat — is what "a steward exists" means. */
      claimed: z.boolean(),
      /** That agent id is still in `paseo agent ls -g`. A deleted agent means the project has no steward. */
      agentPresent: z.boolean(),
    })
    .nullable(),
  spawnReservation: z.object({
    at: z.string(), agentId: z.string().nullable(),
    reconciliation: z.enum(["awaiting-agent", "awaiting-claim", "agents-unreadable", "verified-claim"]),
  }).nullable().default(null),
  dispatchLock: z.object({
    path: z.string(), holder: z.string(), at: z.string().nullable(), ageMinutes: z.number().nullable(),
  }).nullable().default(null),
  batch: z.array(z.string()),
  /** The dispatch ledger as written in control/COMMAND.md: a RECORD, never a source of "running". */
  dispatch: z.array(DispatchRowSchema),
  /** G12: per task, the acceptance artifact and whether its commit and commands pass. Current state. */
  acceptance: z.array(AcceptanceStatusSchema),
  /** Running agents in this project's workspaces, steward sessions excluded. The live worker list. */
  liveAgents: z.array(LiveAgentSchema),
  /** Running steward sessions, excluded from `liveAgents` (the lease's paseo-agent, or the tick title). */
  stewardAgents: z.array(LiveAgentSchema),
  /** False when `paseo agent ls` could not be read: the live lists are then unknown, not empty. */
  agentsReadable: z.boolean(),
  merges: z.array(MergeRowSchema),
  questions: z.array(z.string()),
  ledger: z.looseObject({
    rows: z.number(),
    lastRunId: z.string().nullable(),
    lastConfig: z.string().nullable(),
    lastExit: z.number().nullable(),
    lastAt: z.string().nullable(),
  }),
  fork: z
    .looseObject({
      branch: z.string(),
      head: z.string(),
      dirty: z.number(),
      differsFromFrozen: z.number().nullable(),
    })
    .nullable(),
  workspaces: z.looseObject({
    total: z.number(),
    cap: z.number(),
    /** Worktree workspaces belonging to THIS project — the slot count that matters. */
    projectWorktrees: z.number(),
    stewardLike: z.array(WorkspaceSchema),
  }),
  tick: z.looseObject({
    id: z.string().nullable(),
    status: z.string().nullable(),
    cadence: z.string().nullable(),
    nextRunAt: z.string().nullable(),
    /** The plugin's own tick, which runs in the configured workspace. */
    lastPluginTickAt: z.string().nullable(),
    lastPluginTickResult: z.string().nullable(),
    running: z.boolean(),
  }),
  permissions: z.looseObject({
    autoAllowPlanExit: z.boolean(),
    autoDenyQuestions: z.boolean(),
    autoAllowShell: z.boolean(),
  /** Owner-declared test invocations as exact argv arrays; no prefix matching. */
  safeTestRunners: z.array(z.array(z.string()).min(1)).optional(),
    /** False when `paseo permit ls` could not be read: pending is then unknown, not empty. */
    readable: z.boolean(),
    pending: z.array(PendingRequestSchema),
    /** Agents that are idle while holding a pending request: the deadlock. A CURRENT count. */
    idleWithPending: z.number(),
    /** Automatic answers for this project, newest first. A record of what the plugin did. */
    audit: z.array(PermissionAuditSchema),
    auditError: z.string().nullable(),
    auditRetention: z.object({
      totalCap: z.number(),
      /** All retained rows for this project are returned, without a separate display cutoff. */
      projectCap: z.number(),
      retained: z.number(),
      /** Historical removals from this project's audit, not a current problem count. */
      evicted: z.number(),
      lastEvictedAt: z.string().nullable(),
    }),
  }),
  warnings: z.array(z.string()),
});

export type PermissionAudit = z.infer<typeof PermissionAuditSchema>;
export type PendingRequest = z.infer<typeof PendingRequestSchema>;
export type DispatchRow = z.infer<typeof DispatchRowSchema>;
export type LiveAgent = z.infer<typeof LiveAgentSchema>;
export type MergeRow = z.infer<typeof MergeRowSchema>;
export type AcceptanceStatus = z.infer<typeof AcceptanceStatusSchema>;
export type StewardWorkspace = z.infer<typeof WorkspaceSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;
export type ProjectsResult = z.infer<typeof ProjectsResultSchema>;
export type StewardState = z.infer<typeof StewardStateSchema>;

export const stewardRead = defineRpc({
  name: "steward.read",
  input: z.object({ project: z.string().optional() }),
  output: StewardStateSchema,
});

export const stewardProjects = defineRpc({
  name: "steward.projects",
  input: z.object({}),
  output: ProjectsResultSchema,
});

/** One onboarding gate. The seven are a report, never a claim: a failing gate is named, not hidden. */
export const OnboardGateSchema = z.object({
  id: z.enum([
    "files",
    "git",
    "paseo_project",
    "workspace",
    "acceptance",
    "resume",
    "plan_fields",
  ]),
  pass: z.boolean(),
  detail: z.string(),
});
export type OnboardGate = z.infer<typeof OnboardGateSchema>;

/** The onboarding report. `success` is true only when every gate passes. */
export const OnboardReportSchema = z.object({
  root: z.string(),
  success: z.boolean(),
  gates: z.array(OnboardGateSchema),
  projectId: z.string(),
  workspaceId: z.string(),
});
export type OnboardReport = z.infer<typeof OnboardReportSchema>;

export const stewardControl = defineRpc({
  name: "steward.control",
  input: z.object({
    action: z.enum([
      "tick-now",
      "set-lazy",
      "enable",
      "disable",
      "set-interval",
      "set-workspace",
      "archive-stray",
      "forget-project",
      "set-policy",
      "answer-pending",
      "accept",
      "onboard",
    ]),
    /** Which project to act on. Required for every action except archive-stray; tick-now acts on it alone. */
    project: z.string().optional(),
    intervalMinutes: z.number().min(1).max(1440).optional(),
    workspace: z.string().optional(),
    /** For set-policy: which policy, and whether it is on. */
    policy: z.enum(["plan", "question", "shell"]).optional(),
    on: z.boolean().optional(),
    /** For accept: the manifest id and the exact commit whose artifact is being accepted. */
    task: z.string().min(1).optional(),
    commit: z.string().min(1).optional(),
  }),
  output: z.looseObject({
    proposedRow: z.string().optional(),
    targetPath: z.string().optional(),
    ok: z.boolean(),
    message: z.string(),
    /** Onboard only: the seven gates, so a partial result never reads as success. */
    success: z.boolean().optional(),
    gates: z.array(OnboardGateSchema).optional(),
    projectId: z.string().optional(),
    workspaceId: z.string().optional(),
  }),
});

/** One-line summary: live workers and waiting questions. Nothing historical is counted. */
export function headline(state: StewardState | undefined): string {
  if (!state) return "…";
  const parts = [`${state.liveAgents.length}↻`];
  if (state.questions.length > 0) parts.push(`${state.questions.length}❓`);
  return parts.join(" ");
}
