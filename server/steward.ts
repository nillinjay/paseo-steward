import { execFileSync, execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync, lstatSync, closeSync, existsSync, mkdirSync, readdirSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext, PluginLifecycleEvents, PluginHookContext, PluginServerContext } from "@getpaseo/plugin/server";
import type {
  ProjectConfig,
  ProjectSummary,
  ProjectsResult,
  StewardState,
  StewardWorkspace,
  DispatchRow,
  LiveAgent,
  OnboardGate,
  MergeRow,
  PendingRequest,
  PermissionAudit,
} from "../shared/steward";
import { strikeOutcome, externalPaths, agentIdMatches, classifyRequest, filePathFrom, stewardControl, stewardProjects, stewardRead } from "../shared/steward";
import { progressGet } from "../shared/progress";
import { readProgress } from "./progress";

/** The progress side lane adds one read-only RPC; it changes no scheduling or acceptance rules. */
export function registerProgress(server: PluginServerContext): void {
  server.handle(progressGet, readProgress);
}

const SCHEMA = "paseo-steward/1" as const;
/** Paseo's own worktree ceiling. Implementation concurrency is `maxConcurrent` (2), not this. */
const WORKTREE_CAP = 5;
/** Failed capitalist pokes against the same claim before it is declared void. Persisted, so a reload cannot reset it. */
const POKE_FAILURE_LIMIT = 3;

/**
 * The only four questions a worker may stop for. Every brief carries them verbatim, so a worker no
 * longer has to infer the boundary from a denied permission request.
 */
export const OWNER_ONLY_CLASSES = [
  "widening authorization beyond the standing grant",
  "changing the meaning of a criterion",
  "adding, removing or retiring a work item",
  "changing what the project is allowed to do",
] as const;
export type OwnerOnlyClass = (typeof OWNER_ONLY_CLASSES)[number];

/** The last line of every brief. Anything outside the four is a decision the worker must make itself. */
export const OWNER_ONLY_RULE =
  "If the answer is not one of these four, decide it yourself, record the decision in your report, and keep going.";

/** What a worker sees when it asks anyway: what to do instead, not just a refusal. */
export const QUESTION_DENY_MESSAGE =
  "No operator is present: only widening authorization beyond the standing grant, changing the meaning of a criterion, adding, removing or retiring a work item, or changing what the project is allowed to do may go to the owner; if your question is not one of these four, decide it yourself, record the decision in your report, and keep going.";

const OWNER_ONLY_ALIASES: Record<string, OwnerOnlyClass> = {
  authorization: OWNER_ONLY_CLASSES[0],
  "criterion-meaning": OWNER_ONLY_CLASSES[1],
  "work-items": OWNER_ONLY_CLASSES[2],
  "project-scope": OWNER_ONLY_CLASSES[3],
};

/**
 * The steward's dispatch brief. Manifest-shaped by design (DESIGN-V2 §6, §8): fields plus reference
 * paths, no prose requirements. The protocol itself lives in the referenced files, so this brief can
 * stay short without losing a rule.
 */
export const RESUME_PROMPT = [
  "DISPATCH BRIEF — steward",
  "task_id: STEWARD",
  "lane: standard",
  "tier: senior",
  "risk: R1",
  "brief_kind: delivery",
  "base: 40-hex sha of origin/main at dispatch (never HEAD or a branch)",
  "write_scope: control/RESUME.md, control/COMMAND.md, output/status-one-pager.md",
  "forbidden: client/, checks/, any write inside a supervised project, a network dependency, a second steward",
  "precondition: claim atomically with `mkdir control/.steward-claim`; if it exists, stop before project work and write nothing",
  "ops_actions: [] — every non-git mutation as {cmd, reversible}; reversible: no also needs owner_ack_id",
  "expires_at: null — no third-party dependency; an external acceptance carries an ISO deadline",
  "acceptance: cmd — control/RESUME.md rewritten; one dispatch-ledger row appended; the checks declared in control/COMMAND.md exit 0 (kinds: cmd | measurement:<cmd>+<numeric predicate> | external:<party>)",
  "p0_or_p1: P0",
  "cancel_how: not cancellable — a claimed lease is the steward; finish the batch and keep the claim",
  "reference: control/RESUME.md (read first), control/COMMAND.md (claim, lease, Ready queue, Unattended operation), DESIGN-V2.md §5 §6 §8, docs/templates/worker-brief.md, docs/templates/worker-report.md",
  "dispatch: copy docs/templates/worker-brief.md for every worker — fields only, no prose",
  "report: four fields only — status / commit_sha / artifact_path / error_code+first_root_cause+log_path — per docs/templates/worker-report.md; a BLOCKED status must name blocked_on=<one of the four owner-only classes>",
  "deliverable: a document the owner asked for is written in full; the four fields govern the coordination report only",
  "owner_only: widening authorization beyond the standing grant; changing the meaning of a criterion; adding, removing or retiring a work item; changing what the project is allowed to do",
  `owner_only_rule: ${OWNER_ONLY_RULE}`,
].join("\n");

// ---------------------------------------------------------------- per-project config

/** All retained project rows are returned. Eviction metadata survives the rows it describes. */
type Eviction = { count: number; lastAt: string | null };
type SpawnReservation = { at: string; agentId: string | null };
type ConfigFile = { spawnReservations?: Record<string, SpawnReservation>; projects: ProjectConfig[]; audit: PermissionAudit[]; auditEvictions: Record<string, Eviction> };

/**
 * A finished leg waiting for the R0 gate. It is captured from the worker's own report (DONE + a full
 * commit sha), then acted on by the existing tick. Persisted in the plugin's own config only; a failed
 * attempt stays `failed` so the tick never retries the same commit in a loop.
 */
type PendingGate = {
  id: string;
  task: string;
  attempt: string;
  agentId: string;
  worktree: string;
  commit: string;
  at: string;
  status: "pending" | "passed" | "failed" | "skipped";
  artifactPath: string | null;
  detail: string | null;
};
type GateConfig = { pendingGates?: PendingGate[] };
/** Config rows are loose objects; older files simply have no array yet. */
function gatesOf(cfg: ProjectConfig): PendingGate[] {
  return (cfg as ProjectConfig & GateConfig).pendingGates ?? [];
}
const AUDIT_CAP = 200;
// Actual recovery store, scoped by config path. A durable prepared row also survives a plugin reload.
const unsavedAudit = new Map<string, Map<string, PermissionAudit>>();
const auditErrors = new Map<string, string>();

function configPath(): string {
  return process.env.PASEO_STEWARD_CONFIG ?? join(homedir(), ".paseo-steward.json");
}

function defaultsFor(root: string): ProjectConfig {
  return {
    root,
    paseoProject: process.env.PASEO_STEWARD_PROJECT ?? "",
    workspace: process.env.PASEO_STEWARD_WORKSPACE ?? "",
    provider: process.env.PASEO_STEWARD_PROVIDER ?? "pi/opencode-go/deepseek-v4.1-flash",
    thinking: process.env.PASEO_STEWARD_THINKING ?? "high",
    // The junior tier runs on the OPENCODE harness, not on pi: a junior is cheap hands, and pi's harness is
    // reserved for the steward itself. `provider/model`, so the harness is part of the configured value.
    juniorProvider: process.env.PASEO_STEWARD_JUNIOR_PROVIDER ?? "opencode/deepseek-v4.1-flash-free",
    intervalMinutes: Number(process.env.PASEO_STEWARD_INTERVAL_MIN ?? 20),
    maxConcurrent: Number(process.env.PASEO_STEWARD_MAX_CONCURRENT ?? 2),
    nextTickAt: null,
    lastDispatchAt: null,
    lastPokeAt: null,
    lastPokeFingerprint: null,
    takeoverError: null,
    pokeFailureCount: 0,
    pokeFailureAgent: null,
    pendingWakes: [],
    taskFailures: {},
    lazyMode: false,
    enabled: false,
    leaseStaleMinutes: Number(process.env.PASEO_STEWARD_LEASE_MIN ?? 15),
    autoAllowPlanExit: true,
    autoDenyQuestions: true,
    // v1.0 ships with automatic shell approval OFF (owner ruling, 2026-10-21, option A). Five review rounds showed
    // that auto-approving arbitrary shell cannot be made safe by pattern matching: every round found another
    // executable with a write mode (sed '1w', sort -ro, uniq's output operand, git commit -n, ...). With the switch
    // off, every command waits for a human, and the rest of the machinery - dispatch, wake, acceptance, takeover -
    // is unaffected. Turning it on is a per-project decision that the surface states plainly.
    autoAllowShell: false,
    readOnlyRoots: [],
  };
}

function loadConfig(): ConfigFile {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8")) as Partial<ConfigFile>;
    if (Array.isArray(raw.projects)) {
      // Rows written before a field existed take its default; a stored value always wins.
      const projects = (raw.projects as ProjectConfig[]).map((p) => ({ ...defaultsFor(p.root), ...p }));
      const audit = (Array.isArray(raw.audit) ? raw.audit : []).map((a) => ({
        ...a, attemptId: a.attemptId ?? "", delivery: a.delivery ?? "legacy" as const, recorded: true,
        // Old ok:true meant only that the send call returned, and proves no resolution.
        ok: a.delivery === "confirmed" && a.ok,
      }));
      return { projects, audit, auditEvictions: raw.auditEvictions ?? {}, spawnReservations: raw.spawnReservations ?? {} };
    }
    throw new Error("Invalid steward config: projects must be an array");
  } catch (error) {
    // A missing config is first run. Unreadable/corrupt state must not be replaced by defaults.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { projects: [], audit: [], auditEvictions: {} };
}

function saveConfig(file: ConfigFile): void {
  // Stage only our own config beside its destination; a failed save must not truncate prior intent.
  const staging = `${configPath()}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staging, JSON.stringify(file, null, 2), { encoding: "utf8", mode: 0o600 });
    const fd = openSync(staging, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(staging, configPath());
  } finally {
    try { unlinkSync(staging); } catch { /* absent after rename, or save refused */ }
  }
}

/** Every project the plugin knows about. Reading a project registers it with defaults. */
function projectFor(root: string, create = true): ProjectConfig | null {
  const file = loadConfig();
  const found = file.projects.find((p) => p.root === root);
  if (found) return found;
  if (!create) return null;
  const fresh = defaultsFor(root);
  file.projects.push(fresh);
  try { saveConfig(file); } catch (error) { rememberConfigError(error); }
  return fresh;
}

function rememberConfigError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  auditErrors.set(configPath(), message);
  console.error(`[paseo-steward] config NOT RECORDED: ${message}`);
}

function updateProject(root: string, patch: Partial<ProjectConfig>): ProjectConfig | null {
  const file = loadConfig();
  const idx = file.projects.findIndex((p) => p.root === root);
  if (idx < 0) return null;
  const next = { ...file.projects[idx]!, ...patch, root };
  file.projects[idx] = next;
  saveConfig(file);
  return next;
}

// ---------------------------------------------------------------- process helpers

/**
 * Where the `paseo` CLI lives. Bare "paseo" is not enough: the desktop app can restart with a PATH that no
 * longer contains it (measured 2026-10-20 12:52Z: an app upgrade restarted the daemon, the plugin's child
 * processes lost the binary, every `agent ls` failed, and the panel reported the live steward as GONE).
 */
let resolvedBin: string | null = null;
function paseoBin(): string {
  if (process.env.PASEO_BIN) return process.env.PASEO_BIN;
  if (resolvedBin) return resolvedBin;
  const candidates = [
    process.env.PASEO_CLI ?? "",
    join(homedir(), ".local/bin/paseo"),
    "/usr/local/bin/paseo",
    "/usr/bin/paseo",
  ].filter(Boolean);
  // The AppImage mount carries its own CLI while the desktop app is running.
  try {
    for (const dir of readdirSync("/tmp").filter((d) => d.startsWith(".mount_Paseo-"))) {
      candidates.push(join("/tmp", dir, "resources", "bin", "paseo"));
      candidates.push(join("/tmp", dir, "paseo"));
    }
  } catch {
    /* no /tmp access is not fatal */
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      resolvedBin = candidate;
      return candidate;
    }
  }
  // Last resort: let execFile search PATH.
  return "paseo";
}

function run(cmd: string, args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: 25_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env } },
      (error, stdout, stderr) => {
        // The exit status is the truth. Returning stdout before checking the error turned a failed
        // `paseo run` into "dispatched" and a failed poke into "poked" (review F9), which also reset the
        // durable failure counter, so the bounded recovery could never trip.
        if (error) return reject(Object.assign(new Error((stderr || stdout || "").trim() || error.message), { code: (error as NodeJS.ErrnoException).code }));
        resolve(stdout);
      },
    );
  });
}

async function jsonOrNull<T>(cmd: string, args: string[], cwd?: string): Promise<T | null> {
  try {
    return JSON.parse(await run(cmd, args, cwd)) as T;
  } catch {
    return null;
  }
}

/** Keep the exit status and both streams: a gate failure is a result, not a transport exception. */
function runResult(cmd: string, args: string[], cwd?: string, timeout = 600_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env: { ...process.env } },
      (error, stdout, stderr) => resolve({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? ""),
      }),
    );
  });
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** `var=value` lines from a project's untracked env/refs.env. */
function refs(root: string): Record<string, string> {
  const text = readText(join(root, "env/refs.env"));
  const out: Record<string, string> = {};
  if (!text) return out;
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Z_]+)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Persist a report decision only in the plugin config. No launch or project write occurs here. */
export function recordTaskFailure(root: string, input: {
  task: string; attempt: string; worktree: string; reportId: string; commit: string;
  fingerprint: string; code: "E_LOGIC" | "E_ENV" | "E_FLAKY" | "E_UNKNOWN"; at: string;
}) {
  const cfg = projectFor(root, false);
  if (!cfg) return null;
  const prior = cfg.taskFailures[input.task] ?? [];
  const duplicate = prior.find(row => row.reportId === input.reportId);
  if (duplicate) return duplicate;
  if (prior.some(row => row.attempt === input.attempt && row.disqualified)) return null;
  const decision = strikeOutcome(prior, input);
  const row = { ...input, ...decision, disqualified: decision.escalate,
    ...(decision.escalate ? { escalation: { task: input.task, attempt: input.attempt,
      toProfile: "senior-sol", worktree: input.worktree, at: input.at, reason: decision.reason } } : {}) };
  const failures = prior.map(previous => previous.attempt === input.attempt && decision.escalate
    ? { ...previous, disqualified: true } : previous);
  updateProject(root, { taskFailures: { ...cfg.taskFailures, [input.task]: [...failures, row] } });
  return row;
}

/** Patch one captured gate without dropping rows another completion added while the gate was running. */
function patchPendingGate(root: string, id: string, patch: Partial<PendingGate>): void {
  const cfg = projectFor(root, false);
  if (!cfg) return;
  const gates = gatesOf(cfg).map((row) => row.id === id ? { ...row, ...patch } : row);
  updateProject(root, { pendingGates: gates } as Partial<ProjectConfig>);
}

/**
 * A worker reported DONE with a full commit sha. Capture it only for an enabled project and an R0
 * manifest: the tick later proves the worker is idle and runs the gate. R1/R2 are not captured, so
 * they keep waiting for a human exactly as before.
 */
function captureR0Gate(root: string, input: {
  task: string; attempt: string; agentId: string; worktree: string; commit: string;
}): PendingGate | null {
  const cfg = projectFor(root, false);
  if (!cfg?.enabled) return null;
  const manifest = readManifest(root, input.task);
  if (!manifest || manifest.risk !== "R0") return null;
  const base = typeof manifest.base === "string" ? manifest.base.trim().toLowerCase() : "";
  const commit = input.commit.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(base) || !/^[0-9a-f]{40}$/.test(commit) || base === commit) return null;
  const prior = gatesOf(cfg).find((row) => row.task === input.task && row.commit === commit);
  if (prior) return prior;
  const row: PendingGate = {
    id: randomUUID(), task: input.task, attempt: input.attempt, agentId: input.agentId,
    worktree: input.worktree, commit, at: new Date().toISOString(),
    status: "pending", artifactPath: null, detail: null,
  };
  updateProject(root, { pendingGates: [...gatesOf(cfg), row] } as Partial<ProjectConfig>);
  console.log(`[paseo-steward] auto-gate: captured ${input.task}@${commit.slice(0, 12)} from ${input.agentId.slice(0, 7)}`);
  return row;
}

// ---------------------------------------------------------------- parsers

export type WorkerReportStatus = "DONE" | "BLOCKED" | "FAILED";
export type ParsedWorkerReport = {
  status: WorkerReportStatus;
  commitSha: string;
  artifactPath: string;
  error: string;
  /** The owner-only class a BLOCKED worker is waiting on, or null when it named none. */
  blockedOn: OwnerOnlyClass | null;
  /** The "waiting on owner" counter: only a BLOCKED report that names a class may increment it. */
  waitingOnOwner: boolean;
  /** A BLOCKED report with no class is a decision the worker failed to make, not a wait. */
  decisionFailure: boolean;
};
export type WorkerReportParse =
  | { ok: true; report: ParsedWorkerReport }
  | { ok: false; reason: string };

function reportField(text: string, name: string): string {
  const match = new RegExp(`^\\s*${name}\\s*[:=]\\s*(.*)$`, "mi").exec(text);
  return (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
}

function ownerOnlyClassIn(text: string): OwnerOnlyClass | null {
  const alias = /(?:blocked_on|blocked-on|owner_only)\s*[:=]\s*([a-z-]+)/i.exec(text)?.[1]?.toLowerCase() ?? "";
  if (alias in OWNER_ONLY_ALIASES) return OWNER_ONLY_ALIASES[alias]!;
  const flat = text.toLowerCase().replace(/\s+/g, " ");
  return OWNER_ONLY_CLASSES.find((cls) => flat.includes(cls.toLowerCase())) ?? null;
}

/**
 * Parse a worker's four-field report. A BLOCKED report must name one of the four owner-only classes;
 * otherwise the steward rejects it as a decision the worker failed to make, so "waiting on owner" can
 * never be a euphemism for "stopped because it did not want to decide".
 */
export function parseWorkerReport(text: string): WorkerReportParse {
  const raw = reportField(text, "status").toUpperCase();
  if (raw !== "DONE" && raw !== "BLOCKED" && raw !== "FAILED") {
    return { ok: false, reason: "no status line (expected status=DONE|BLOCKED|FAILED)" };
  }
  const status = raw as WorkerReportStatus;
  const blockedOn = status === "BLOCKED" ? ownerOnlyClassIn(text) : null;
  const report: ParsedWorkerReport = {
    status,
    commitSha: reportField(text, "commit_sha"),
    artifactPath: reportField(text, "artifact_path"),
    error: reportField(text, "error"),
    blockedOn,
    waitingOnOwner: status === "BLOCKED" && blockedOn !== null,
    decisionFailure: status === "BLOCKED" && blockedOn === null,
  };
  if (report.decisionFailure) {
    return {
      ok: false,
      reason: "BLOCKED report names none of the four owner-only classes — the steward treats it as a decision the worker failed to make",
    };
  }
  return { ok: true, report };
}

function parseLease(text: string | null, staleMinutes: number): StewardState["lease"] {
  if (!text) return null;
  // NOTE: `\Z` is not an escape in JavaScript — it matches a literal "Z", and the lease block
  // contains one inside `since=…T07:51Z`, so the block was truncated mid-line. Use `$` (no `m`
  // flag, so end-of-string) instead.
  const block = /##\s*Lease\s*\n([\s\S]*?)(?:\n##\s|\n>\s|$)/.exec(text);
  const body = block?.[1] ?? "";
  const get = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}=(.+)$`, "m").exec(body);
    return m ? m[1]!.trim() : null;
  };
  const session = get("session");
  if (!session) return null;
  // The block is written by agents, and some write `f975956 (scheduled steward tick, interval)` — an id and a
  // human label. Comparing the whole string against real ids reported a live steward as missing, which the UI
  // showed as 主管已不在 and would have made the wheel 接管 a duplicate. Keep only the leading id token.
  const paseoAgentRaw = (get("paseo-agent") ?? get("paseoAgent") ?? "").trim();
  const paseoAgent = /^[0-9a-f]{7,}(?:-[0-9a-f]{4,})+/i.exec(paseoAgentRaw)?.[0] ?? /^[0-9a-f]{7,}/i.exec(paseoAgentRaw)?.[0] ?? paseoAgentRaw;
  // `state=released` is the hand-over signal; it is read in the dispatch gate, parsed here so the UI shows it.
  const heartbeat = get("heartbeat") ?? "";
  const state = get("state") ?? "unknown";
  const hbMs = Date.parse(heartbeat);
  const nowMs = Date.now();
  const heartbeatAgeMinutes = Number.isFinite(hbMs) ? Math.round((nowMs - hbMs) / 60_000) : null;
  const heartbeatInFuture = Number.isFinite(hbMs) ? hbMs > nowMs + 60_000 : false;
  // `released` is a deliberate hand-over, not an absence: the steward finished and wants a successor now.
  const stale = state === "open" || state === "released" || heartbeatAgeMinutes === null
    ? true
    : heartbeatAgeMinutes > staleMinutes;
  return {
    session,
    paseoAgent,
    since: get("since") ?? "",
    heartbeat,
    state,
    heartbeatAgeMinutes,
    heartbeatInFuture,
    // A heartbeat in the future is never "fresh": it means the clock was wrong.
    stale,
    // The owner's rule: a claimed lease IS a steward. Age only says whether it is worth poking, never
    // whether one exists. An empty or placeholder `paseo-agent` is the only "no steward".
    claimed: agentIdMatches(paseoAgent, paseoAgent),
    agentPresent: false,
  };
}

function tableSection(text: string | null, heading: string): { header: string[]; rows: string[][] } {
  if (!text) return { header: [], rows: [] };
  const start = text.indexOf(heading);
  if (start < 0) return { header: [], rows: [] };
  const lines = text.slice(start).split("\n");
  const rows: string[][] = [];
  let header: string[] | null = null;
  for (const line of lines.slice(1)) {
    const t = line.trim();
    // A heading always ends the requested section, even when its table has zero data rows. Without this
    // bound an empty `## Ready queue` skipped the next heading and consumed the Dispatch ledger as work
    // (review F3, the R3 layout).
    if (/^#{1,6}\s/.test(t)) break;
    if (!t.startsWith("|")) {
      if (header) break;
      continue;
    }
    if (/^\|[\s:-]+\|/.test(t)) continue;
    const cells = t.split("|").slice(1, -1).map((c) => c.trim());
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.length > 0) rows.push(cells);
  }
  return { header: header ?? [], rows };
}

function tableRows(text: string | null, heading: string): string[][] {
  return tableSection(text, heading).rows;
}

function parseDispatch(text: string | null): DispatchRow[] {
  if (!text) return [];
  const start = text.indexOf("## Dispatch ledger");
  if (start < 0) return [];
  const lines = text.slice(start).split("\n");
  const rows: string[][] = [];
  let header: string[] | null = null;
  for (const line of lines.slice(1)) {
    const t = line.trim();
    if (/^#{1,6}\s/.test(t)) break;
    if (!t.startsWith("|")) continue;
    if (/^\|[\s:-]+\|/.test(t)) continue;
    const cells = t.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!header) {
      header = cells;
      continue;
    }
    if (cells.length > 0) rows.push(cells);
  }
  if (!header) return [];
  const index = (name: string): number =>
    header!.findIndex((cell) => cell.toLowerCase() === name || cell.toLowerCase().includes(name));
  const legAt = index("leg");
  const statusAt = index("status");
  const employeeAt = Math.max(index("employee"), index("agent"));
  const workspaceAt = index("workspace");
  const branchAt = index("branch");
  const gateAt = index("gate");
  const updatedAt = Math.max(index("updated"), index("note"));
  const out: DispatchRow[] = [];
  for (const cells of rows) {
    const cell = (at: number): string => (at >= 0 ? cells[at] ?? "" : "");
    const status = cell(statusAt);
    const flat = status.toLowerCase();
    out.push({
      leg: cell(legAt),
      workspace: cell(workspaceAt),
      branch: cell(branchAt),
      employee: cell(employeeAt),
      status,
      gate: cell(gateAt),
      updated: cell(updatedAt),
      done: /\bmerged\b/.test(flat) || /harvested/.test(flat) || /returned/.test(flat) || /reworked/.test(flat),
      blockedInRecord: /blocked|stopped|rejected|incomplete|wrong/.test(flat),
    });
  }
  return out;
}

function parseMerges(text: string | null): MergeRow[] {
  const rows = tableRows(text, "| at | branch | leg | gate | commit |");
  const out: MergeRow[] = [];
  for (const cells of rows) {
    if (cells.length < 5) continue;
    out.push({ at: cells[0]!, branch: cells[1]!, leg: cells[2]!, gate: cells[3]!, commit: cells[4]! });
  }
  return out;
}

/** Owner questions are the one thing the owner reads, so surface them verbatim. */
function parseQuestions(text: string | null): string[] {
  if (!text) return [];
  const idx = text.search(/^##\s*要你回话的事/m);
  if (idx < 0) return [];
  const body = text.slice(idx).split(/\n##\s/)[0] ?? "";
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("##")) continue;
    if (t.startsWith("-") || t.startsWith("**") || t.startsWith("A") || t.startsWith("B") || t.startsWith("C")) {
      out.push(t.replace(/^[-*]\s*/, ""));
    }
  }
  return out.slice(0, 12);
}

function parseBatch(text: string | null): string[] {
  if (!text) return [];
  const batches = new Map<string, { active: boolean; items: string[] }>();
  let current: string | null = null;
  for (const line of text.split("\n")) {
    const named = /\bBatch\s+(\d+)\b/i.exec(line);
    if (named) current = named[1]!;
    else if (/^#{1,6}\s/.test(line)) current = null;
    if (!current) continue;
    const batch = batches.get(current) ?? { active: false, items: [] };
    // Require an explicit ACTIVE declaration. Newer prose alone is not current-state evidence.
    const status = named ? line : /^\s*(?:\*\*)?status\b/i.test(line) ? line : "";
    if (/\bACTIVE\b/i.test(status)) batch.active = true;
    if (/\b(completed?|closed|inactive|cancelled|canceled|retired)\b/i.test(status)) batch.active = false;
    const declaration = /is therefore:[ \t]*(.*)/i.exec(line);
    if (declaration) {
      batch.items = [...declaration[1]!.matchAll(/`([^`]+)`|leg\s+(\d+)|\b(W\d+)\b/gi)]
        .map((x) => x[1] ?? x[2] ?? x[3] ?? "").filter(Boolean);
    }
    batches.set(current, batch);
  }
  const active = [...batches.values()].filter((b) => b.active);
  // Conflicting ACTIVE markers are ambiguous. Display no current batch rather than inventing one.
  return active.length === 1 ? active[0]!.items : [];
}

function parseLedgerTail(text: string | null): StewardState["ledger"] {
  if (!text) return { rows: 0, lastRunId: null, lastConfig: null, lastExit: null, lastAt: null };
  const lines = text.split("\n").filter((l) => l.trim());
  const last = lines[lines.length - 1];
  let row: Record<string, unknown> = {};
  try {
    row = JSON.parse(last ?? "") as Record<string, unknown>;
  } catch {
    /* keep the count */
  }
  return {
    rows: lines.length,
    lastRunId: typeof row.run_id === "string" ? row.run_id : null,
    lastConfig: typeof row.config === "string" ? row.config : null,
    lastExit: typeof row.exit_code === "number" ? row.exit_code : null,
    lastAt: typeof row.finished_utc === "string" ? row.finished_utc : null,
  };
}

// ---------------------------------------------------------------- acceptance artifacts (G12)

/**
 * What an acceptance artifact records. Two writers exist: `checks/guard.cjs` writes
 * `guard-<task>-<commit>.json` with `gate.commands[].exit_code`, and `checks/accept.cjs` writes
 * `<leg>-<sha>.json` with `commands[].exitCode`. Both are read here so acceptance never depends on
 * which tool produced the evidence.
 */
type ArtifactCommand = { cmd: string | null; exitCode: number | null };
type AcceptanceArtifact = {
  task: string;
  /** Repo-relative, POSIX separators: what the dispatch-ledger row must cite. */
  path: string;
  sha: string | null;
  commands: ArtifactCommand[];
  allCommandsPassed: boolean;
  verdict: string | null;
  legacyFormat: boolean;
  cleanCommit: boolean;
  attempt: string | null;
  at: number;
};

const ARTIFACT_FILE = /^(?:guard-)?(.+)-([0-9a-f]{40})\.json$/i;
const commandExit = (entry: Record<string, unknown>): number | null => {
  if (typeof entry.exit_code === "number") return entry.exit_code;
  if (typeof entry.exitCode === "number") return entry.exitCode;
  return null;
};

function commitExists(root: string, sha: string): boolean {
  if (!/^[0-9a-f]{40}$/i.test(sha)) return false;
  try {
    execFileSync("git", ["cat-file", "-e", sha + "^{commit}"], { cwd: root, stdio: "ignore" });
    return true;
  } catch { return false; }
}

function commitInHistory(root: string, sha: string, head: string): boolean {
  if (!commitExists(root, sha) || !/^[0-9a-f]{40}$/i.test(head)) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, head], { cwd: root, stdio: "ignore" });
    return true;
  } catch { return false; }
}

/** Every acceptance artifact in `checks/out`, newest first. Unreadable or malformed files are skipped. */
function readArtifacts(root: string): AcceptanceArtifact[] {
  const dir = join(root, "checks/out");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: AcceptanceArtifact[] = [];
  for (const name of names) {
    const match = ARTIFACT_FILE.exec(name);
    if (!match) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(readText(join(dir, name)) ?? "") as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const gate = record.gate as Record<string, unknown> | undefined;
    const rawCommands = Array.isArray(gate?.commands)
      ? gate.commands
      : Array.isArray(record.commands)
        ? record.commands
        : [];
    const commands: ArtifactCommand[] = rawCommands
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
      .map((entry) => ({
        cmd: typeof entry.cmd === "string" ? entry.cmd : null,
        exitCode: commandExit(entry),
      }));
    const task =
      typeof record.task === "string" ? record.task
        : typeof record.leg === "string" ? record.leg
          : match[1]!;
    const sha = typeof record.commit === "string" ? record.commit
      : typeof record.sha === "string" ? record.sha
        : match[2]!;
    const generated = typeof record.generated_at === "string" ? Date.parse(record.generated_at) : NaN;
    out.push({
      task,
      attempt: typeof record.attempt_id === "string" ? record.attempt_id : typeof record.attempt === "string" ? record.attempt : null,
      path: `checks/out/${name}`,
      sha: sha.toLowerCase(),
      commands,
      allCommandsPassed: record.verdict === "PASS"
        && (record.scope as { pass?: unknown } | undefined)?.pass === true
        && gate?.pass === true && commitExists(root, sha)
        && commands.length > 0 && commands.every((entry) => entry.exitCode === 0 && entry.cmd !== null)
        && rawCommands.every((entry: Record<string, unknown>) =>
          entry.kind !== "external" && entry.status !== "EXTERNAL_ACCEPTANCE")
        && record.status !== "EXTERNAL_ACCEPTANCE",
      verdict: typeof record.verdict === "string" ? record.verdict : null,
      // An artifact written before the aggregate fields existed cannot be judged, only labelled.
      legacyFormat: typeof record.verdict !== "string" || !record.gate || !record.scope,
      cleanCommit: (record.provenance as { clean?: unknown; commit?: unknown } | undefined)?.clean === true
        && (record.provenance as { commit?: unknown }).commit === sha,
      at: Number.isFinite(generated) ? generated : 0,
    });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** The committed manifest for a task, or null. Used only to recover an acceptance record, never to certify. */
function readManifest(root: string, task: string): Record<string, unknown> | null {
  try {
    const raw = JSON.parse(readFileSync(join(root, "checks/tasks", `${task}.json`), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  } catch { return null; }
}

/** The task a permission row belongs to: an explicit field wins, otherwise its agent title names it. */
function auditTaskOf(row: PermissionAudit): string | null {
  const loose = row as PermissionAudit & Record<string, unknown>;
  for (const key of ["task", "task_id", "taskId"]) {
    const value = loose[key];
    if (typeof value === "string" && /^T-[A-Za-z0-9][A-Za-z0-9_-]*$/i.test(value.trim())) return value.trim().toUpperCase();
  }
  const match = /\b(T-[A-Za-z0-9][A-Za-z0-9_-]*)\b/i.exec(typeof row.agentTitle === "string" ? row.agentTitle : "");
  return match ? match[1]!.toUpperCase() : null;
}

/** Request/decision timestamps may come from newer rows or from older loose fixtures. */
function auditStamp(row: PermissionAudit, keys: string[], nested: string[]): number | null {
  const loose = row as PermissionAudit & Record<string, unknown>;
  for (const key of keys) {
    const value = loose[key];
    if (typeof value === "string" || typeof value === "number") {
      const ms = typeof value === "number" ? value : Date.parse(value);
      if (Number.isFinite(ms)) return ms;
    }
  }
  for (const container of nested) {
    const value = loose[container];
    if (!value || typeof value !== "object") continue;
    const found = auditStamp(value as PermissionAudit, keys, []);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Per-task wait and cycle from rows already in the audit log. A missing request timestamp contributes
 * zero (an unknown wait is not evidence of a long one), and old rows with only a decision time are valid.
 */
function auditMetrics(audit: PermissionAudit[]): Map<string, { permissionWaitMs: number; firstAt: number | null }> {
  const out = new Map<string, { permissionWaitMs: number; firstAt: number | null }>();
  for (const row of audit) {
    const task = auditTaskOf(row);
    if (!task) continue;
    const decided = auditStamp(row, ["at", "decidedAt", "decisionAt", "decided_at"], ["decision"]);
    const requested = auditStamp(row,
      ["requestedAt", "requestAt", "requested_at", "askedAt", "queuedAt"],
      ["request", "permission", "metadata"]) ?? decided;
    if (decided === null && requested === null) continue;
    const wait = decided !== null && requested !== null ? Math.max(0, decided - requested) : 0;
    const bucket = out.get(task) ?? { permissionWaitMs: 0, firstAt: null };
    bucket.permissionWaitMs += wait;
    const anchor = decided ?? requested!;
    if (bucket.firstAt === null || anchor < bucket.firstAt) bucket.firstAt = anchor;
    out.set(task, bucket);
  }
  return out;
}

/** One current row per task: a manifest with no artifact still appears, at `implemented, unverified`. */
export function acceptanceState(root: string, head: string | null): StewardState["acceptance"] {
  const artifacts = readArtifacts(root);
  const taskFailures = projectFor(root, false)?.taskFailures ?? {};
  const metrics = auditMetrics(readAudit(root).audit);
  const tasks = new Set<string>([
    ...artifacts.map((artifact) => artifact.task),
    ...Object.keys(taskFailures),
  ]);
  try {
    for (const name of readdirSync(join(root, "checks/tasks"))) {
      if (name.endsWith(".json")) tasks.add(name.slice(0, -".json".length));
    }
  } catch {
    /* a project with no manifests simply has no tasks to report */
  }
  const out: StewardState["acceptance"] = [];
  for (const task of [...tasks].sort()) {
    const candidates = artifacts.filter((artifact) => artifact.task === task);
    // Git's topology, never the verdict or a wall-clock timestamp, orders applicable evidence.
    const inHistory = (entry: AcceptanceArtifact) => head !== null && entry.sha !== null
      && commitInHistory(root, entry.sha, head);
    let history: string[] = [];
    if (head) {
      try { history = execFileSync("git", ["rev-list", "--topo-order", head], { cwd: root, encoding: "utf8" }).trim().split("\n"); }
      catch { /* no readable history means no certification */ }
    }
    const applicable = candidates.filter(inHistory).sort((a, b) =>
      history.indexOf(a.sha!) - history.indexOf(b.sha!) || b.at - a.at || a.path.localeCompare(b.path));
    const artifact = applicable[0] ?? candidates[0];
    const certified = artifact ? inHistory(artifact) : false;
    const provenance = artifact?.cleanCommit === true;
    // A leg accepted before artifacts were retained has no artifact left. Its acceptance is still a fact in the
    // manifest (`acceptedAt`); calling that "unverified" is as wrong as calling it certified (owner, 2026-10-20).
    const manifest = readManifest(root, task);
    const failures = taskFailures[task] ?? [];
    // Evidence without attempt identity cannot clear a disqualification. A new identified attempt can.
    const disqualified = failures.some(row => row.disqualified &&
      (!artifact?.attempt || row.attempt === artifact.attempt));
    const legacyAccepted = !artifact && typeof manifest?.acceptedAt === "string";
    const acceptedAtMs = typeof manifest?.acceptedAt === "string" ? Date.parse(manifest.acceptedAt) : NaN;
    const acceptanceAt = Number.isFinite(acceptedAtMs) ? acceptedAtMs : (artifact?.at || null);
    const metric = metrics.get(task);
    const cycleMs = acceptanceAt !== null && metric?.firstAt != null
      ? Math.max(0, acceptanceAt - metric.firstAt) : null;
    out.push({
      task,
      status: disqualified ? "failed" : !artifact
        ? (legacyAccepted ? "legacy-accepted" : "unverified")
        // Evidence for a commit this repository does not contain cannot be judged, only labelled.
        : !certified || artifact.legacyFormat ? "legacy-artifact"
          // Evidence without provenance is still evidence of a run; it is not re-verifiable, so it reads
          // legacy-artifact rather than "unverified", which would claim no artifact existed.
          : artifact.allCommandsPassed ? (provenance ? "certified" : "legacy-artifact") : "failed",
      note: disqualified ? "attempt disqualified: senior takeover required" : !artifact
        ? (legacyAccepted ? `accepted ${String(manifest!.acceptedAt)}; its artifact was not retained` : "")
        : !provenance && artifact.allCommandsPassed ? "evidence lacks clean committed-tree provenance"
          : artifact.legacyFormat ? "artifact predates the aggregate verdict; not re-verified" : "",
      artifactPath: artifact?.path ?? null,
      artifactExists: Boolean(artifact),
      sha: artifact?.sha ?? null,
      // Compatibility field: certification survives subsequent commits and merges.
      commitMatchesHead: artifact && head !== null ? certified : null,
      allCommandsPassed: !disqualified && certified && provenance && (artifact?.allCommandsPassed ?? false),
      commandCount: artifact?.commands.length ?? 0,
      verdict: artifact && certified && artifact.sha !== head
        ? `${artifact.verdict ?? "unknown"} · ancestor of HEAD (not HEAD)` : artifact?.verdict ?? null,
      permissionWaitMs: metric?.permissionWaitMs ?? 0,
      cycleMs,
    });
  }
  return out;
}

/** Propose a ledger row for the authorized steward session; never mutate the supervised tree. */
function proposeDispatchRow(root: string, task: string, artifactPath: string, sha: string): string {
  const text = readText(join(root, "control/COMMAND.md"));
  if (text === null) throw new Error("control/COMMAND.md does not exist");
  const table = text.split("## Dispatch ledger")[1] ?? "";
  const header = table.split("\n").find((line) => line.trim().startsWith("|"));
  const columns = header?.split("|").slice(1, -1).length ?? 4;
  const at = new Date().toISOString();
  const status = "accepted by gate, review pending";
  return columns >= 7
    ? `| ${task} | | ${task} | ${artifactPath} | ${status} | ${artifactPath} @ ${sha} | ${at} |`
    : `| ${task} | ${status} | ${artifactPath} | ${sha} · ${at} |`;
}

async function gitState(dir: string): Promise<StewardState["git"]> {
  try {
    const [branch, head, status, counts] = await Promise.all([
      run("git", ["branch", "--show-current"], dir),
      run("git", ["rev-parse", "--short", "HEAD"], dir),
      run("git", ["status", "--porcelain"], dir),
      run("git", ["rev-list", "--left-right", "--count", "origin/main...HEAD"], dir).catch(() => "0\t0"),
    ]);
    const [behind, ahead] = (counts.trim() || "0\t0").split(/\s+/).map(Number);
    return {
      branch: branch.trim() || "(detached)",
      head: head.trim(),
      dirtyFiles: status.split("\n").filter((l) => l.trim()).length,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  } catch {
    return null;
  }
}

/**
 * A brief written just before its own commit is the normal case, so a couple of minutes of slack keeps
 * that commit from being reported as a stale brief. Anything older is a tree a successor cannot trust.
 */
const RESUME_GRACE_MS = 2 * 60_000;

/** The `更新时间：<ISO>` line of a hand-over brief, as epoch ms. `null` when absent or unparsable. */
function resumeUpdatedAt(text: string | null): number | null {
  if (!text) return null;
  const match = /更新时间\s*[：:]\s*[*_`]*\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)/.exec(text);
  if (!match) return null;
  const stamp = match[2] ? match[1]! : `${match[1]}Z`;
  const ms = Date.parse(stamp.replace(" ", "T"));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * How far the tree has moved past the one-screen brief. A missing or undated RESUME.md is `null`, not
 * stale: an absent brief is a different problem, and "unknown" must never be reported as "fresh".
 */
async function resumeStale(root: string): Promise<{ minutes: number } | null> {
  const updated = resumeUpdatedAt(readText(join(root, "control/RESUME.md")));
  if (updated === null) return null;
  try {
    const headAt = Date.parse((await run("git", ["log", "-1", "--format=%cI"], root)).trim());
    if (!Number.isFinite(headAt)) return null;
    const lag = headAt - updated;
    if (lag <= RESUME_GRACE_MS) return null;
    return { minutes: Math.round(lag / 60_000) };
  } catch {
    return null;
  }
}

async function forkState(root: string): Promise<StewardState["fork"]> {
  const fork = refs(root).SOLVER_FORK;
  if (!fork) return null;
  try {
    const [branch, head, status] = await Promise.all([
      run("git", ["branch", "--show-current"], fork),
      run("git", ["rev-parse", "--short", "HEAD"], fork),
      run("git", ["status", "--porcelain"], fork),
    ]);
    return {
      branch: branch.trim() || "(detached)",
      head: head.trim(),
      dirty: status.split("\n").filter((l) => l.trim()).length,
      differsFromFrozen: null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- read one project

type RawWorkspace = Record<string, unknown>;

async function workspaceList(): Promise<StewardWorkspace[]> {
  const raw = await jsonOrNull<RawWorkspace[]>(paseoBin(), ["workspace", "ls", "--json"]);
  return (raw ?? []).map((w) => ({
    project: String(w.project ?? ""),
    id: String(w.workspaceId ?? ""),
    name: String(w.name ?? ""),
    isolation: String(w.isolation ?? ""),
    cwd: String(w.cwd ?? ""),
    stewardLike: false,
  }));
}

type RawAgent = Record<string, unknown>;

/** The title prefix of a session the plugin's own tick starts; such a session is a steward, not a worker. */
function tickTitlePrefix(root: string): string {
  return `${basename(root)} steward tick`;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Every agent the daemon knows, across all directories and statuses. `null` when unreadable. */
async function allAgents(): Promise<RawAgent[] | null> {
  const raw = await jsonOrNull<RawAgent[]>(paseoBin(), ["agent", "ls", "-g", "--json"]);
  return Array.isArray(raw) ? raw : null;
}

type RawPermit = Record<string, unknown>;

/** Every request pending now (`paseo permit ls --json`). `null` when unreadable. */
async function pendingPermits(): Promise<RawPermit[] | null> {
  const raw = await jsonOrNull<RawPermit[]>(paseoBin(), ["permit", "ls", "--json"]);
  return Array.isArray(raw) ? raw : null;
}

/** Pending requests held by agents in this project's workspaces, with each agent's current status. */
function pendingFor(permits: RawPermit[], agents: RawAgent[], own: StewardWorkspace[]): PendingRequest[] {
  const cwds = new Set(own.map((w) => w.cwd.replace(/\/+$/, "")));
  const byId = new Map(agents.map((a) => [String(a.id ?? ""), a]));
  const out: PendingRequest[] = [];
  for (const p of permits) {
    const agent = byId.get(String(p.agentId ?? ""));
    if (!agent || !cwds.has(expandHome(String(agent.cwd ?? "")).replace(/\/+$/, ""))) continue;
    const name = String(p.name ?? "");
    out.push({
      agentId: String(p.agentId ?? ""),
      agentName: String(agent.name ?? ""),
      agentStatus: String(agent.status ?? ""),
      requestId: String(p.id ?? ""),
      request: name,
      description: typeof p.description === "string" ? p.description : "",
      // CLI rows with no SDK kind are unknown until the sweep refreshes the SDK handle.
      kind: classifyRequest(name, typeof p.kind === "string" ? p.kind : undefined, typeof p.description === "string" ? p.description : undefined),
    });
  }
  return out;
}

/**
 * Split the running agents that sit in one of this project's workspaces into workers and steward
 * sessions. A steward is the lease holder (`paseo-agent`, full or short id) or a session the tick started.
 */
function liveAgentsFor(
  running: RawAgent[],
  own: StewardWorkspace[],
  root: string,
  leaseAgent: string,
): { workers: LiveAgent[]; stewards: LiveAgent[] } {
  const byCwd = new Map(own.map((w) => [w.cwd.replace(/\/+$/, ""), w.id]));
  const workers: LiveAgent[] = [];
  const stewards: LiveAgent[] = [];
  for (const a of running) {
    const cwd = expandHome(String(a.cwd ?? "")).replace(/\/+$/, "");
    const workspaceId = byCwd.get(cwd);
    if (!workspaceId) continue;
    const agent: LiveAgent = {
      id: String(a.id ?? ""),
      name: String(a.name ?? ""),
      provider: String(a.provider ?? ""),
      cwd,
      workspaceId,
    };
    const isLease = agentIdMatches(agent.id, leaseAgent);
    const isTick = agent.name.startsWith(tickTitlePrefix(root));
    (isLease || isTick ? stewards : workers).push(agent);
  }
  return { workers, stewards };
}

/**
 * A session that names itself read-only holds no implementation slot (DESIGN-V2 §5.3a). Read-only legs
 * stay in the main workspace, while an implementation leg belongs in its own worktree. The CLI exposes
 * only a name, so an unlabelled main-workspace session is treated as an implementation worker and still
 * costs a slot: under-counting real work is the more expensive mistake.
 */
function isReadOnlyAgent(agent: LiveAgent): boolean {
  return /\b(review(?:er)?|read[- ]?only|audit(?:or)?|analysis|analyst|red[- ]?team|critique|inspect(?:ion|or)?)\b/i.test(agent.name);
}

/** Running workers that occupy an implementation slot: worktree workers plus unlabelled main-workspace workers. */
function implementationSlotsInUse(live: { workers: LiveAgent[] }, own: StewardWorkspace[]): number {
  const worktreeIds = new Set(own.filter((w) => w.isolation === "worktree").map((w) => w.id));
  return live.workers.filter((a) => worktreeIds.has(a.workspaceId) || !isReadOnlyAgent(a)).length;
}

/**
 * Free implementation slots, as one pure calculation. The surface and the capitalist poke must agree:
 * when they each did their own arithmetic, the poke could claim a free slot the surface called busy.
 */
export function implementationSlotsFree(
  own: StewardWorkspace[],
  live: { workers: LiveAgent[] },
  maxConcurrent: number,
): { free: number; cap: number } {
  const worktrees = own.filter((w) => w.isolation === "worktree").length;
  const cap = Math.max(1, maxConcurrent);
  const busy = Math.max(worktrees, implementationSlotsInUse(live, own));
  return { free: Math.max(0, cap - busy), cap };
}

/** Read one project. `create` registers an unknown root so a new project just works. */
export async function readSteward(input: RpcInput<typeof stewardRead>): Promise<StewardState> {
  await discoverProjects();
  const root = input.project && input.project.length > 0 ? input.project : loadConfig().projects[0]?.root ?? "";
  const cfg = projectFor(root) ?? defaultsFor(root);
  const projectExists = existsSync(root);
  const cmdText = readText(join(root, "control/COMMAND.md"));
  const onboarded = cmdText !== null;
  const warnings: string[] = [];
  const dispatchLock = readDispatchLock();
  if (dispatchLock) warnings.push(dispatchLockWarning(dispatchLock));
  if (cfg.pendingWakes.length > 0) {
    warnings.push(`pending completion delivery: ${cfg.pendingWakes.length} worker notice(s), oldest ${cfg.pendingWakes[0]!.at}; failed deliveries for this claim: ${cfg.pokeFailureCount}. ${cfg.lazyMode && cfg.enabled ? "The wheel will retry even with an empty Ready queue." : "Delivery is paused; waiting for a human to enable lazy mode."}`);
  }

  const [git, fork, allWorkspaces, agents, permits, staleBrief, headSha] = await Promise.all([
    gitState(root),
    forkState(root),
    workspaceList(),
    allAgents(),
    pendingPermits(),
    resumeStale(root),
    run("git", ["rev-parse", "HEAD"], root).then((sha) => sha.trim().toLowerCase()).catch(() => null),
  ]);
  const running = agents === null ? null : agents.filter((a) => a.status === "running");

  const lease = parseLease(cmdText, cfg.leaseStaleMinutes);
  if (lease && lease.claimed) {
    lease.agentPresent = (agents ?? []).some((a) => {
      const id = String(a.id ?? "");
      return a.status !== "error" && a.status !== "idle" && agentIdMatches(id, lease.paseoAgent);
    });
    // Delivery failures remain visible, but never prove that a listed agent stopped.

  }
  const reserved = loadConfig().spawnReservations?.[root];
  const reconciliation = !reserved?.agentId ? "awaiting-agent"
    : agents === null ? "agents-unreadable"
    : lease?.claimed && agentIdMatches(reserved.agentId, lease.paseoAgent)
      && agents.some(a => agentIdMatches(String(a.id ?? ""), reserved.agentId!)) ? "verified-claim" : "awaiting-claim";
  const spawnReservation: StewardState["spawnReservation"] = reserved ? { ...reserved, reconciliation } : null;
  if (spawnReservation && reconciliation !== "verified-claim") {
    warnings.push(`spawn reservation: ${reconciliation}; created ${reserved!.at}; agent ${reserved!.agentId ?? "unknown"}. Dispatch remains blocked until a verified claim is reconciled.`);
  }
  if (cfg.takeoverError) warnings.push(cfg.takeoverError);
  const dispatch = parseDispatch(cmdText);
  const readyQueue = parseReadyQueue(cmdText);
  const acceptance = acceptanceState(root, headSha);
  const merges = parseMerges(readText(join(root, "control/MERGES.md")));
  const questions = parseQuestions(readText(join(root, "output/status-one-pager.md")));
  const batch = parseBatch(readText(join(root, "control/WAVES.md")));
  const ledger = parseLedgerTail(readText(join(root, "runs/ledger.jsonl")));

  // Worktrees live under the Paseo home, so associate by the project NAME, not by cwd.
  const projectName = basename(root);
  const own = allWorkspaces.filter((w) => w.project === projectName || w.cwd === root);
  const stewardLike = own
    .filter((w) => w.cwd === root && w.isolation === "local")
    .map((w) => ({ ...w, stewardLike: true }));
  const live = liveAgentsFor(running ?? [], own, root, lease?.paseoAgent ?? "");
  if (running === null) warnings.push("`paseo agent ls` could not be read, so the live worker count is unknown.");
  const pending = pendingFor(permits ?? [], agents ?? [], own);
  const idleHolders = [...new Set(pending.filter((p) => p.agentStatus === "idle").map((p) => p.agentId.slice(0, 7)))];
  if (idleHolders.length > 0) {
    warnings.push(`${idleHolders.length} agent(s) are idle with a pending request (${idleHolders.join(", ")}) — the turn cannot close and no completion notification will be sent until it is answered.`);
  }
  if (permits === null) warnings.push("`paseo permit ls` could not be read, so pending requests are unknown.");
  const strays = stewardLike.filter((w) => w.id !== cfg.workspace);

  if (onboarded && !cfg.workspace) {
    warnings.push(`no steward workspace is configured for ${projectName}. Pick the one workspace this project's steward may run in ("set-workspace"); until then the tick cannot start.`);
  }
  if (onboarded && lease?.heartbeatInFuture) {
    warnings.push(`lease heartbeat is in the FUTURE (${lease.heartbeat}, age ${lease.heartbeatAgeMinutes} min) — a future heartbeat never looks stale, so the handover would silently never happen. Write it from \`date -u\`.`);
  }
  // An old heartbeat is NOT an absence: the claim decides existence (owner ruling). Warn only when the
  // claim points at nothing, because that is the one case where the project really has no steward.
  if (onboarded && lease && lease.claimed && agents === null) {
    warnings.push(`the agent list could not be read, so the claimed steward ${lease.paseoAgent.slice(0, 7)} is UNKNOWN — no 接管 and no void decision until a successful read.`);
  } else if (onboarded && lease && lease.claimed && !lease.agentPresent) {
    warnings.push(`the lease claims agent ${lease.paseoAgent.slice(0, 7)} but Paseo does not have it — the next slot scan will 接管 with a new steward.`);
  }
  if (onboarded && lease && !lease.claimed) {
    warnings.push("no agent has claimed the lease — the next slot scan will 接管 with a steward.");
  }
  if (onboarded && strays.length > 0) {
    warnings.push(`${strays.length} extra local workspace(s) point at this project (${strays.map((w) => w.id).join(", ")}) — the steward belongs in ${cfg.workspace || "one configured workspace"} only. Use "archive-stray".`);
  }
  // Implementation capacity counts slots that a leg actually holds: worktree workers and unlabelled
  // main-workspace workers. Read-only sessions are not capacity (review F7). The surface still reports
  // the WORKTREE count, never this agent count.
  const worktreeSlots = own.filter((w) => w.isolation === "worktree").length;
  const occupied = Math.max(worktreeSlots, implementationSlotsInUse(live, own));
  const ineligibleP1 = readyQueue.filter((r) => r.priority === "P1" && r.cancelHow.trim() === "");
  if (onboarded && ineligibleP1.length > 0) {
    warnings.push(`${ineligibleP1.length} P1 row(s) have no cancel_how (${ineligibleP1.map((r) => r.label).join(", ")}) — a P1 without a cancellation clause cannot be dispatched; add cancel_how or make the row P0.`);
  }
  if (onboarded && occupied < Math.min(2, cfg.maxConcurrent)) {
    warnings.push(`only ${occupied} of ${cfg.maxConcurrent} implementation slot(s) are busy — fill toward ${Math.min(2, cfg.maxConcurrent)} when the graph allows.`);
  }
  if (onboarded && git && git.dirtyFiles > 0) warnings.push(`project tree has ${git.dirtyFiles} uncommitted file(s).`);
  if (onboarded && staleBrief) {
    warnings.push(`RESUME.md is older than the latest commit (${staleBrief.minutes} min) — a successor would trust a stale brief.`);
  }
  if (onboarded && fork && fork.dirty > 0) warnings.push(`solver fork has ${fork.dirty} uncommitted file(s) — a fork leg is mid-write; no other fork writer may start.`);
  const auditState = readAudit(root);

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    clockUtc: new Date().toISOString(),
    project: root,
    onboarded,
    config: cfg,
    projectExists,
    git,
    lease,
    dispatchLock,
    spawnReservation,
    batch,
    dispatch,
    acceptance,
    liveAgents: live.workers,
    stewardAgents: live.stewards,
    agentsReadable: running !== null,
    merges,
    questions,
    ledger,
    fork,
    workspaces: { total: allWorkspaces.length, cap: WORKTREE_CAP, projectWorktrees: worktreeSlots, stewardLike },
    tick: {
      id: null,
      status: null,
      cadence: `${cfg.intervalMinutes} min`,
      nextRunAt: cfg.nextTickAt ?? null,
      lastPluginTickAt: lastTick.at,
      lastPluginTickResult: lastTick.result,
      running: tickTimer !== null && cfg.enabled,
    },
    permissions: {
      autoAllowPlanExit: cfg.autoAllowPlanExit,
      autoDenyQuestions: cfg.autoDenyQuestions,
      autoAllowShell: cfg.autoAllowShell,
      readable: permits !== null,
      pending,
      idleWithPending: idleHolders.length,
      ...auditState,
    },
    warnings,
  };
}

/**
 * Discover projects from Paseo itself: a `local` workspace points at a project directory, and that
 * workspace is the natural steward home for it. The owner's rule is "one steward per project, in one
 * workspace", so the first local workspace found for a root becomes the designated one and any further
 * local workspace at the same root is reported as a stray.
 */
async function discoverProjects(): Promise<void> {
  const all = await workspaceList();
  const locals = all.filter((w) => w.isolation === "local" && w.cwd.startsWith("/"));
  const file = loadConfig();
  let changed = false;
  for (const w of locals) {
    const existing = file.projects.find((p) => p.root === w.cwd);
    if (!existing) {
      file.projects.push({ ...defaultsFor(w.cwd), workspace: w.id });
      changed = true;
      continue;
    }
    if (!existing.workspace) {
      existing.workspace = w.id;
      changed = true;
    }
  }
  if (changed) {
    try { saveConfig(file); } catch (error) { rememberConfigError(error); }
  }
}

/** One cheap pass over every known project, for the sidebar and the project picker. */
export async function readProjects(_input: RpcInput<typeof stewardProjects>): Promise<ProjectsResult> {
  await discoverProjects();
  const file = loadConfig();
  const summaries: ProjectSummary[] = [];
  for (const cfg of file.projects) {
    const state = await readSteward({ project: cfg.root });
    summaries.push({
      root: cfg.root,
      name: basename(cfg.root),
      onboarded: state.onboarded,
      workspace: cfg.workspace,
      enabled: cfg.enabled,
      intervalMinutes: cfg.intervalMinutes,
      workersLive: state.liveAgents.length,
      questions: state.questions.length,
      leaseState: state.lease?.state ?? null,
      leaseStale: state.lease?.stale ?? null,
      warnings: state.warnings.length,
    });
  }
  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    projects: summaries,
    totals: {
      workersLive: summaries.reduce((n, p) => n + p.workersLive, 0),
      questions: summaries.reduce((n, p) => n + p.questions, 0),
      warnings: summaries.reduce((n, p) => n + p.warnings, 0),
    },
  };
}

// ---------------------------------------------------------------- control and tick

const lastTick: { at: string | null; result: string | null } = { at: null, result: null };
let tickTimer: NodeJS.Timeout | null = null;

/**
 * The wheel beats far faster than the hand-over interval. A long `setInterval(interval)` is reset by every
 * plugin load — measured: six reloads in 40 minutes, gaps of 18/1/4/32/5 against a 20-minute interval, so
 * the timer almost never fired. The schedule therefore lives in `nextTickAt` (on disk) and this wheel only
 * asks "is it due?". A released lease is not a timer event at all; it is picked up on the next beat.
 */
const WHEEL_MS = 30_000;
/** Never start two stewards for one project inside this window; a crash-loop becomes visible, not a storm. */
const DISPATCH_FLOOR_MS = 2 * 60_000;

/** A reservation is global to this config. Read its evidence without ever expiring or removing it. */
function readDispatchLock(): StewardState["dispatchLock"] {
  const path = `${configPath()}.dispatch.lock`;
  try {
    const stat = statSync(path);
    let holder = "unknown (unreadable or malformed holder metadata)";
    let at: string | null = null;
    try {
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (Number.isInteger(value.pid)) holder = `pid=${value.pid}`;
      if (typeof value.at === "string") at = value.at;
    } catch { /* the lock still blocks dispatch even when its metadata cannot be read */ }
    return { path, holder, at, ageMinutes: Math.max(0, Math.floor((Date.now() - stat.mtimeMs) / 60_000)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return { path, holder: "unknown (lock could not be inspected)", at: null, ageMinutes: null };
  }
}

function dispatchLockWarning(lock: NonNullable<StewardState["dispatchLock"]>): string {
  return `dispatch reservation: ${lock.path}; holder ${lock.holder}; age ${lock.ageMinutes === null ? "unknown" : `${lock.ageMinutes} min`}. This lock blocks dispatch for ALL projects using this config. Stop all dispatchers for this config and verify the holder has stopped before removing an orphan lock. Age never expires it.`;
}

/** Compare-and-set under an exclusive config-side lock, shared by automatic and manual dispatchers. */
function reserveDispatch(cfg: ProjectConfig, manual = false): { cfg: ProjectConfig; release: () => void } | null {
  // Runtime state belongs beside our config, never in a supervised project. Do not expire a lock by
  // age: a paused writer could resume after expiry and dispatch alongside its replacement. A crash
  // leaves this lock fail-closed; remove an orphan only after stopping all dispatchers for this config.
  const lock = `${configPath()}.dispatch.lock`;
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const release = () => { try { closeSync(fd); } finally { unlinkSync(lock); } };
  let reserved = false;
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const file = loadConfig();
    const fresh = file.projects.find((p) => p.root === cfg.root);
    // No await between this fresh comparison and the durable write. Another reservation wins even if
    // dispatchGate evaluated an older row; manual dispatch keeps its explicit floor override.
    if (file.spawnReservations?.[cfg.root]) return null;
    if (!fresh?.enabled || fresh.lastDispatchAt !== cfg.lastDispatchAt || (!manual && !fresh.lazyMode)) return null;
    const prior = fresh.lastDispatchAt ? Date.parse(fresh.lastDispatchAt) : NaN;
    const now = Date.now();
    if (!manual && Number.isFinite(prior) && now - prior < DISPATCH_FLOOR_MS) return null;
    // A manual override in the same millisecond must still change the compare-and-set token.
    fresh.lastDispatchAt = new Date(Number.isFinite(prior) ? Math.max(now, prior + 1) : now).toISOString();
    (file.spawnReservations ??= {})[cfg.root] = { at: fresh.lastDispatchAt, agentId: null };
    saveConfig(file);
    reserved = true;
    return { cfg: fresh, release };
  } finally {
    if (!reserved) release();
  }
}

/** The cheapest possible read of one project's dispatchability: config plus the lease block, no CLI, no git. */
/** The rows of `## Ready queue` — the only honest answer to "is there work". */
type ReadyRow = {
  cells: string[];
  /** The leg/task label from the first column, without markdown emphasis. */
  label: string;
  priority: "P0" | "P1" | null;
  cancelHow: string;
};

/**
 * The Ready queue is typed, not a bag of cells. Priority decides who may run (P0 always, P1 only when
 * it carries a cancellation clause), so the slot scan must read the columns, not just the row count.
 * A table without a priority column is the legacy layout and stays dispatchable (review F8).
 */
function parseReadyQueue(text: string | null): ReadyRow[] {
  const { header, rows } = tableSection(text, "## Ready queue");
  const priorityAt = header.findIndex((h) => /^(p|prio|priority|p0_?or_?p1|p0\/p1|p0p1)$/i.test(h.trim().replace(/\s+/g, "_")));
  const cancelAt = header.findIndex((h) => /cancel/i.test(h));
  return rows.map((cells) => {
    const priorityCell = priorityAt >= 0 ? (cells[priorityAt] ?? "").replace(/[*_`]/g, "") : "";
    const match = /\bP([01])\b/i.exec(priorityCell);
    return {
      cells,
      label: (cells[0] ?? "").replace(/[*_`]/g, "").trim(),
      priority: match ? (`P${match[1]}` as "P0" | "P1") : null,
      cancelHow: cancelAt >= 0 ? (cells[cancelAt] ?? "").trim() : "",
    };
  });
}

/**
 * Does this project HAVE a steward? The owner's rule, and the one the UI shows: a lease block that names
 * an agent which still exists in Paseo. The heartbeat is not evidence of existence — only of recency.
 */
function stewardExists(lease: StewardState["lease"]): boolean {
  return Boolean(lease?.claimed && lease.agentPresent);
}

/**
 * The only two lawful starts, and neither is a timer:
 *   - no claim, or a claim naming an agent that Paseo no longer has -> 接管, one steward, in the main workspace;
 *   - a steward exists -> nothing. Never a successor, never a hand-over.
 */
let agentsCache: { at: number; rows: RawAgent[] | null } | null = null;

/** `paseo agent ls -g` is a process spawn, so the gate reads it at most once a minute. */
async function agentsCached(): Promise<RawAgent[] | null> {
  if (agentsCache && Date.now() - agentsCache.at < 60_000) return agentsCache.rows;
  const rows = await allAgents();
  agentsCache = { at: Date.now(), rows };
  return rows;
}

async function dispatchGate(cfg: ProjectConfig, manual = false): Promise<
  | { dispatch: true; why: string }
  | { dispatch: false; why: string; nextAt: string | null; steward: boolean; lease: StewardState["lease"]; unknown?: boolean }
> {
  const lease = parseLease(readText(join(cfg.root, "control/COMMAND.md")), cfg.leaseStaleMinutes);
  const file = loadConfig();
  const outstanding = file.spawnReservations?.[cfg.root];
  if (outstanding) {
    const agents = outstanding.agentId && lease?.claimed && agentIdMatches(outstanding.agentId, lease.paseoAgent)
      ? await allAgents() : null;
    if (agents?.some((a) => agentIdMatches(String(a.id ?? ""), outstanding.agentId!))) {
      delete file.spawnReservations![cfg.root];
      saveConfig(file);
    } else {
      return { dispatch: false, why: "outstanding spawn reservation — awaiting verified claim", nextAt: cfg.nextTickAt, steward: false, lease, unknown: true };
    }
  }
  const now = Date.now();
  if (!manual && !cfg.lazyMode) return { dispatch: false, why: "懒人模式 is off", nextAt: cfg.nextTickAt ?? null, steward: false, lease };
  let why: string;
  if (lease?.claimed) {
    const agents = await (manual ? allAgents() : agentsCached());
    // UNKNOWN is not absence (review F2). A failed or malformed list must never start a duplicate steward,
    // and must not advance the void-claim counter either.
    if (agents === null) {
      return {
        dispatch: false,
        why: `the agent list is unreadable, so the claimed steward ${lease.paseoAgent.slice(0, 7)} is UNKNOWN — no 接管 and no void decision`,
        nextAt: cfg.nextTickAt ?? null,
        steward: false,
        lease,
        unknown: true,
      };
    }
    lease.agentPresent = agents.some((a) => {
      const id = String(a.id ?? "");
      return a.status !== "error" && a.status !== "idle" && agentIdMatches(id, lease.paseoAgent);
    });
    const failures = cfg.pokeFailureAgent === lease.paseoAgent ? cfg.pokeFailureCount : 0;
    if (lease.agentPresent) {
      return { dispatch: false, why: `a steward is claimed (${lease.paseoAgent.slice(0, 7)}); failed pokes: ${failures}`, nextAt: cfg.nextTickAt ?? null, steward: true, lease };
    }
    why = "the claimed agent no longer exists or is idle or in error";
  } else {
    why = "no agent has claimed the lease";
  }
  // The floor is on disk (review F1): an in-memory map is empty after a reload and invisible to a second process.
  const floor = cfg.lastDispatchAt ? Date.parse(cfg.lastDispatchAt) : 0;
  if (!manual && Number.isFinite(floor) && now - floor < DISPATCH_FLOOR_MS) {
    return { dispatch: false, why: "within the 2-minute dispatch floor", nextAt: cfg.nextTickAt ?? null, steward: false, lease };
  }
  return { dispatch: true, why };
}

/**
 * The capitalist rule. A steward that lets paid slots sit empty while work is queued is wasting the owner's
 * money, so every five minutes the plugin checks the slots and, when some are free and the Ready queue is not,
 * pokes the SAME steward with one line. It never starts an agent: the poke is a cached turn.
 */
const CAPITALIST_MS = 5 * 60_000;
/** Re-poking with the same facts is the same waste in a smaller package: same state, longer interval. */
const POKE_REPEAT_MS = 20 * 60_000;
const lastCapitalistAt = new Map<string, number>();

export type CapitalistChosen = { label: string; priority: "P0" | "P1" | null; cancelHow: string };

/** The exact poke text, built without I/O so the "fill BOTH slots in one turn" rule is testable. */
export function capitalistMessage(input: {
  free: number;
  cap: number;
  queueLength: number;
  chosen: CapitalistChosen;
  ineligibleP1: Array<{ label: string }>;
  juniorProvider: string;
}): string {
  const { free, cap, queueLength, chosen, ineligibleP1, juniorProvider } = input;
  return [
    `【资本家巡检】工位空闲 ${free}/${cap}，Ready queue 还有 ${queueLength} 项。`,
    `优先派廉价劳动力：初级工程师 \`${juniorProvider}\`。探路、复现、分析、文档、测试、翻译先给初级。`,
    "只有两种情况才升级到高级模型：任务本身有真实风险（权限边界、并发、数据迁移），或初级已经失败两次——并且要在 COMMAND.md 里写下升级原因。",
    `本轮把 ${free} 个空闲工位一次填满（同一轮并行派出 ${free} 条实现腿，每条一个独立 worktree）；不要一轮只派一条。`,
    "不要让工位空着：先派 P0 顶项；P0 不可运行时，才用带取消方式的 P1 填谷。",
    chosen.priority === "P1"
      ? `本次只填谷：P1 顶项「${chosen.label}」。取消方式：${chosen.cancelHow}。P0 一忙立即撤回。`
      : chosen.priority === "P0"
        ? `优先派 P0 顶项：「${chosen.label}」。`
        : `优先派队列顶项：「${chosen.label}」。`,
    "每条实现腿都使用自己的 worktree 工作区（every implementation leg gets its own worktree）；只读腿留在主工作区。收尾时归档工作区并删分支。",
    ...(ineligibleP1.length > 0
      ? [`警告：${ineligibleP1.map((r) => `「${r.label}」`).join("、")} 是 P1 但没有 cancel_how，不可派；补上取消方式或改成 P0。`]
      : []),
  ].join("\n");
}

async function capitalistScan(cfg: ProjectConfig, lease: StewardState["lease"]): Promise<string | null> {
  if (!armed(cfg) || !stewardExists(lease)) return null;
  const now = Date.now();
  if (now - (lastCapitalistAt.get(cfg.root) ?? 0) < CAPITALIST_MS) return null;
  const text = readText(join(cfg.root, "control/COMMAND.md"));
  const queue = parseReadyQueue(text);
  if (queue.length === 0) return null; // nothing to fill the slots with; do not spend a turn saying so
  // P0 wins regardless of table order. P1 is fill-valley only: without a non-empty cancel_how it may not
  // be dispatched at all, because the owner could never call it back (review F8, DESIGN-V2 §5.5).
  const ineligibleP1 = queue.filter((r) => r.priority === "P1" && r.cancelHow.trim() === "");
  const chosen = queue.find((r) => r.priority === "P0")
    ?? queue.find((r) => r.priority === "P1" && r.cancelHow.trim() !== "")
    ?? queue.find((r) => r.priority === null)
    ?? null;
  if (!chosen) {
    const warning = `${basename(cfg.root)}: ${ineligibleP1.length} P1 row(s) have no cancel_how (${ineligibleP1.map((r) => r.label).join(", ")}) — not dispatchable, so no slot-fill poke.`;
    lastCapitalistAt.set(cfg.root, now);
    console.log(`[paseo-steward] capitalist: ${warning}`);
    return warning;
  }
  const [ws, agents] = await Promise.all([workspaceList(), agentsCached()]);
  const own = ws.filter((w) => w.project === basename(cfg.root) || w.cwd === cfg.root);
  // A worker in the MAIN workspace costs no worktree slot but is not idle capacity either. Read-only
  // sessions, however, hold no implementation slot at all (review F7). Concurrency is the owner's 2
  // implementation slots, not Paseo's 5-worktree ceiling.
  const { free, cap } = implementationSlotsFree(
    own,
    liveAgentsFor((agents ?? []).filter((x) => x.status === "running"), own, cfg.root, lease!.paseoAgent),
    cfg.maxConcurrent,
  );
  if (free === 0) return null;
  // A repeated poke that says exactly what the last one said buys nothing. Same free/queued fingerprint
  // means the steward heard it and decided; only a change, or twenty minutes of silence, earns another turn.
  const fingerprint = `${free}/${queue.length}`;
  const priorAt = cfg.lastPokeAt ? Date.parse(cfg.lastPokeAt) : NaN;
  if (cfg.lastPokeFingerprint === fingerprint && Number.isFinite(priorAt) && now - priorAt < POKE_REPEAT_MS) return null;
  lastCapitalistAt.set(cfg.root, now);
  updateProject(cfg.root, { lastPokeAt: new Date(now).toISOString(), lastPokeFingerprint: fingerprint });
  const message = capitalistMessage({
    free, cap, queueLength: queue.length, chosen, ineligibleP1, juniorProvider: cfg.juniorProvider,
  });
  try {
    await run(paseoBin(), ["agent", "send", lease!.paseoAgent, message, "--behavior", "steer", "--no-wait"], cfg.root);
    updateProject(cfg.root, { pokeFailureCount: 0, pokeFailureAgent: null });
    console.log(`[paseo-steward] capitalist: poked ${basename(cfg.root)} steward ${lease!.paseoAgent.slice(0, 7)} (free ${free}, queued ${queue.length})`);
    return `${basename(cfg.root)}: poked the steward — ${free} free slot(s), ${queue.length} queued`;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A listed claim whose send fails is NOT healthy (review F1). Count consecutive failures on disk: the
    // reload that follows every plugin load must not hand the same unusable claim a fresh streak.
    const fresh = loadConfig().projects.find((p) => p.root === cfg.root);
    const count = (fresh?.pokeFailureAgent === lease!.paseoAgent ? fresh.pokeFailureCount : 0) + 1;
    updateProject(cfg.root, { pokeFailureCount: count, pokeFailureAgent: lease!.paseoAgent });
    console.log(`[paseo-steward] capitalist: poke failed for ${basename(cfg.root)} — ${detail} (${count}/${POKE_FAILURE_LIMIT})`);
    if (count >= POKE_FAILURE_LIMIT) {
      console.log(`[paseo-steward] capitalist: claim ${lease!.paseoAgent.slice(0, 7)} has ${count} consecutive failed pokes — dispatch remains blocked while it is present`);
    }
    return null;
  }
}

/**
 * Run the R0 gate for legs captured from DONE reports. This is still the one existing tick, just an
 * earlier step than dispatch. A gate is only touched while its worker is idle (a running worker may
 * still move the commit), and a failed commit is terminal, so the tick can never spin on it.
 */
async function autoGatePass(cfg: ProjectConfig): Promise<string[]> {
  const pending = gatesOf(cfg).filter((row) => row.status === "pending");
  if (pending.length === 0) return [];
  const agents = await agentsCached();
  if (agents === null) {
    console.log(`[paseo-steward] auto-gate: ${basename(cfg.root)} skipped — agent list unreadable`);
    return [];
  }
  const results: string[] = [];
  for (const row of pending) {
    const agent = agents.find((candidate) => agentIdMatches(String(candidate.id ?? ""), row.agentId));
    // A report says DONE; only an idle worker proves it stopped writing to that commit.
    if (!agent || String(agent.status ?? "") !== "idle") continue;
    const manifest = readManifest(cfg.root, row.task);
    if (!manifest) {
      patchPendingGate(cfg.root, row.id, { status: "failed", detail: "manifest missing" });
      results.push(`${basename(cfg.root)}: auto-gate ${row.task} failed — manifest missing`);
      continue;
    }
    if (manifest.risk !== "R0") {
      patchPendingGate(cfg.root, row.id, { status: "skipped", detail: `risk ${String(manifest.risk)}` });
      continue;
    }
    const base = typeof manifest.base === "string" ? manifest.base.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{40}$/.test(base)) {
      patchPendingGate(cfg.root, row.id, { status: "failed", detail: "manifest base is not a full commit sha" });
      results.push(`${basename(cfg.root)}: auto-gate ${row.task} failed — bad manifest base`);
      continue;
    }
    const guard = process.env.PASEO_STEWARD_GUARD || [
      join(cfg.root, "checks/guard.cjs"), join(process.cwd(), "checks/guard.cjs"),
    ].find((candidate) => existsSync(candidate));
    if (!guard) {
      patchPendingGate(cfg.root, row.id, { status: "failed", detail: "checks/guard.cjs not found" });
      results.push(`${basename(cfg.root)}: auto-gate ${row.task} failed — guard script missing`);
      continue;
    }
    const artifactPath = `checks/out/guard-${row.task}-${row.commit}.json`;
    const result = await runResult(process.execPath, [
      guard, "check", "--task", row.task, "--base", base, "--commit", row.commit,
      "--worktree", row.worktree, "--registry", cfg.root,
    ], cfg.root);
    const passed = result.code === 0
      && /^SCOPE_PASS$/m.test(result.stdout) && /^GATE_PASS$/m.test(result.stdout);
    const detail = passed ? null
      : (result.stderr.trim().split("\n").filter(Boolean).at(-1)
        ?? result.stdout.trim().split("\n").filter(Boolean).at(-1) ?? `exit ${result.code}`);
    patchPendingGate(cfg.root, row.id, {
      status: passed ? "passed" : "failed",
      artifactPath: existsSync(join(row.worktree, artifactPath)) ? artifactPath : null,
      detail,
    });
    const message = `${basename(cfg.root)}: auto-gate ${row.task} ${passed ? "PASS" : "FAIL"} at ${row.commit.slice(0, 12)}`;
    console.log(`[paseo-steward] ${message}`);
    results.push(message);
  }
  return results;
}

export async function wheelPass(reason: string): Promise<string[]> {
  const results: string[] = [];
  for (const cfg of loadConfig().projects) {
    if (!cfg.enabled) continue;
    if (!existsSync(join(cfg.root, "control/COMMAND.md"))) continue; // not a steward project
    // The gate does not need a steward workspace: it is read-only proof of a finished leg.
    results.push(...await autoGatePass(cfg));
    if (!cfg.workspace) continue; // the enable path refuses this, so it is only reachable if edited by hand
    const gate = await dispatchGate(cfg);
    if (!gate.dispatch) {
      if (gate.nextAt !== cfg.nextTickAt) updateProject(cfg.root, { nextTickAt: gate.nextAt });
      if (gate.unknown) {
        // A read failure is a state, not silence: report it instead of treating it as absence (review F2).
        console.log(`[paseo-steward] wheel: ${gate.why}`);
        results.push(gate.why);
      }
      if (gate.steward) {
        await flushWake(cfg.root);
        const poke = cfg.pendingWakes.length ? null : await capitalistScan(cfg, gate.lease);
        if (poke) results.push(poke);
      }
      continue;
    }
    const reservation = reserveDispatch(cfg);
    if (!reservation) {
      const lock = readDispatchLock();
      if (lock) {
        const warning = dispatchLockWarning(lock);
        console.log(`[paseo-steward] wheel: ${warning}`);
        results.push(warning);
      }
      continue;
    }
    try {
      const { message } = await spawnSteward(reservation.cfg, reason === "interval" ? "takeover" : reason);
      // The only outward signal that the wheel is alive. `tick.running` is in-process state and a reload
      // resets it, so the acceptance reads this line in `paseo plugin logs`, not the flag.
      console.log(`[paseo-steward] wheel (${gate.why}): ${message}`);
      results.push(message);
      updateProject(cfg.root, { nextTickAt: new Date(Date.now() + cfg.intervalMinutes * 60_000).toISOString() });
    } finally { reservation.release(); }
  }
  if (results.length > 0) {
    lastTick.at = new Date().toISOString();
    lastTick.result = results.join(" · ");
  }
  return results;
}

async function spawnSteward(cfg: ProjectConfig, reason: string): Promise<{ ok: boolean; message: string }> {
  const args = [
    "run", "--no-wait",
    "--workspace", cfg.workspace,
    "--provider", cfg.provider,
    "--thinking", cfg.thinking,
    "--title", `${tickTitlePrefix(cfg.root)} (${reason})`,
    RESUME_PROMPT,
  ];
  try {
    const output = await run(paseoBin(), args, cfg.root);
    // A successful launch is not a published claim. Keep intent across reloads; output without a
    // full agent identity remains uncertain and cannot authorize another launch.
    const file = loadConfig();
    const reservation = file.spawnReservations?.[cfg.root];
    if (reservation) {
      reservation.agentId = output.match(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i)?.[0] ?? null;
      saveConfig(file);
    }
    updateProject(cfg.root, { pokeFailureCount: 0, pokeFailureAgent: null, takeoverError: null });
    return { ok: true, message: `${basename(cfg.root)}: dispatched into ${cfg.workspace}` };
  } catch (error) {
    // Only failure to execute proves no child was launched. Non-zero exit, timeout and transport
    // errors can follow creation of an agent, so they retain the reservation.
    if (["ENOENT", "EACCES", "ENOEXEC"].includes(String((error as NodeJS.ErrnoException).code))) {
      const file = loadConfig();
      delete file.spawnReservations?.[cfg.root];
      saveConfig(file);
    }
    const message = `takeover failed at ${new Date().toISOString()}: ${error instanceof Error ? error.message : String(error)}`;
    updateProject(cfg.root, { takeoverError: message });
    return { ok: false, message: `${basename(cfg.root)}: ${message}` };
  }
}

/**
 * The manual hand-over (`tick-now`, the pill, the owner). It ignores the schedule and the floor, because a
 * timing override never overrides a present or unknown claim. `only` scopes it to ONE project — without it the pass
 * visits every enabled project, which is what the old LEG 2 bug did.
 */
export async function tickOnce(reason: string, only?: string): Promise<string[]> {
  const file = loadConfig();
  const results: string[] = [];
  const scope = only === undefined ? file.projects : file.projects.filter((p) => p.root === only);
  if (only !== undefined && scope.length === 0) results.push(`${basename(only)}: skipped — unknown project`);
  for (const cfg of scope) {
    if (!cfg.enabled) continue;
    if (!existsSync(join(cfg.root, "control/COMMAND.md"))) continue; // not a steward project
    if (!cfg.workspace) {
      results.push(`${basename(cfg.root)}: skipped — no steward workspace configured`);
      continue;
    }
    results.push(...await autoGatePass(cfg));
    const gate = await dispatchGate(cfg, true);
    if (!gate.dispatch) {
      results.push(`${basename(cfg.root)}: skipped — ${gate.why}`);
      continue;
    }
    const reservation = reserveDispatch(cfg, true);
    if (!reservation) {
      const lock = readDispatchLock();
      results.push(lock ? dispatchLockWarning(lock) : `${basename(cfg.root)}: skipped — another dispatcher reserved the project`);
      continue;
    }
    try {
      results.push((await spawnSteward(reservation.cfg, reason)).message);
      updateProject(cfg.root, { nextTickAt: new Date(Date.now() + cfg.intervalMinutes * 60_000).toISOString() });
    } finally { reservation.release(); }
  }
  lastTick.at = new Date().toISOString();
  lastTick.result = results.length > 0
    ? results.join(" · ")
    : only !== undefined ? `${basename(only)}: skipped — hand-over is off or not onboarded` : "no project has the tick enabled";
  return results;
}

function startTimer(): void {
  if (tickTimer) clearInterval(tickTimer);
  const enabled = loadConfig().projects.some((p) => p.enabled);
  if (!enabled) {
    tickTimer = null;
    return;
  }
  tickTimer = setInterval(() => void wheelPass("interval"), WHEEL_MS);
  tickTimer.unref?.();
  // One beat at start-up, so a lease released while the plugin was down is picked up immediately.
  setTimeout(() => void wheelPass("interval"), 2_000).unref?.();
}

// ---------------------------------------------------------------- 懒人模式: a finished worker wakes the steward

/**
 * A project participates only when it is BOTH enabled and in lazy mode. The two can drift: the UI toggles them
 * together, but a hand-edited config or an older record can leave lazy on while enabled is off. That drift woke
 * a stopped project's steward every few minutes on 2026-10-20 — the owner saw a project "running by itself".
 */
function armed(cfg: ProjectConfig | null | undefined): cfg is ProjectConfig {
  return Boolean(cfg?.enabled && cfg?.lazyMode);
}

const WAKE_QUIET_MS = 1_500;
const wakeBuffers = new Map<string, NodeJS.Timeout>();
const wakesInFlight = new Set<string>();
const WAKE_INSTRUCTION = [
  "按协议继续，不要回话给业主。收工报告只要四个字段（格式见 docs/templates/worker-report.md）：",
  "status=<DONE|NO-ANOMALY|CLOSED-DISCARDED|SOURCE_UNAVAILABLE|EXTERNAL_ACCEPTANCE>",
  "commit_sha=<sha 或 ->",
  "artifact_path=<repo 相对路径 或 ->",
  "error: error_code=<CODE>; first_root_cause=<首个确定性根因>; log_path=<路径>",
  "结局按 brief_kind 五选一，见 docs/templates/worker-report.md；不要一律写 DONE。",
  "status=BLOCKED 必须在 error 里写 blocked_on=<四类之一>；不写就视为你没做决定，报告会被驳回。",
  "1. 复跑刚完成那条腿的验收（`node checks/accept.cjs <leg>`，或该腿在 plan.md 里声明的命令）。",
  "2. 通过则接受并把 Ready queue 顶项派出去；不通过则返修或重派，写下原因。",
  "3. 只有四类事才需要问业主：扩大授权、改某条判据的含义、增减或退休工作项、改变项目被允许做的事。其余自己决定。",
  "4. 收工前把结果写进 `control/COMMAND.md`；Batch 汇总写进 `output/status-one-pager.md`。",
  "5. 交付物豁免：业主点名要的文档照写全文，四字段只约束协调消息。",
].join("\n");

async function flushWake(root: string): Promise<void> {
  if (wakesInFlight.has(root)) return;
  const cfg = projectFor(root, false);
  if (!armed(cfg) || !cfg.pendingWakes.length) return;
  const lease = parseLease(readText(join(root, "control/COMMAND.md")), cfg.leaseStaleMinutes);
  const claimId = lease?.paseoAgent ?? "";
  if (!agentIdMatches(claimId, claimId)) {
    console.log(`[paseo-steward] lazy: no steward session to wake for ${basename(root)} — a successor needs a hand-over`);
    return;
  }
  const notices = cfg.pendingWakes;
  const text = [...notices.map((n) => n.line), "", WAKE_INSTRUCTION].join("\n");
  wakesInFlight.add(root);
  try {
    // SDK refs need the real id, not a CLI shorthand. Resolve short claims with the presence rule.
    let stewardId = claimId;
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(claimId)) {
      const agents = await allAgents();
      const matches = (agents ?? []).filter((a) => agentIdMatches(String(a.id ?? ""), claimId));
      if (matches.length !== 1) return; // unknown, absent or ambiguous: retain the durable notice
      stewardId = String(matches[0]!.id);
    }
    if (context_paseo) await context_paseo.agents.ref(stewardId).send(text, { activeTurnBehavior: "steer" });
    else await run(paseoBin(), ["agent", "send", stewardId, text, "--behavior", "steer", "--no-wait"], root);
    // Preserve notices added while this delivery was in flight. A crash before this write retries
    // the notice rather than losing progression: delivery is deliberately at least once.
    const delivered = new Set(notices.map((n) => n.id));
    const fresh = projectFor(root, false)!;
    updateProject(root, { pendingWakes: fresh.pendingWakes.filter((n) => !delivered.has(n.id)), pokeFailureCount: 0, pokeFailureAgent: null });
    console.log(`[paseo-steward] lazy: woke steward ${stewardId.slice(0, 7)} for ${basename(root)} — ${notices.length} worker(s)`);
  } catch (error) {
    const fresh = projectFor(root, false)!;
    const count = (fresh.pokeFailureAgent === claimId ? fresh.pokeFailureCount : 0) + 1;
    updateProject(root, { pokeFailureCount: count, pokeFailureAgent: claimId });
    console.log(`[paseo-steward] lazy: wake failed for ${basename(root)} — ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    wakesInFlight.delete(root);
  }
}

/**
 * The daemon API, captured from the first lifecycle event: `PluginServerContext` carries no `paseo`
 * handle, only the hook context does, and the wake path runs 1.5 s after the event.
 */
let context_paseo: PluginHookContext["paseo"] | null = null;

/**
 * The closed loop. A worker's turn ends; the SAME steward session is woken with one line. Nothing polls and
 * nothing respawns: the steward's context is already loaded, so a wake is one cached turn, not a cold start.
 * Workers that finish within 1.5 s of each other are coalesced into one message.
 */
export function onTurnEnded(
  event: PluginLifecycleEvents["agent.turn_ended"],
  context: PluginHookContext,
): void {
  const agent = event.agent;
  context_paseo = context.paseo;
  void (async () => {
    const cfg = await projectOfAgent(agent.cwd);
    if (!cfg) return;
    const lease = parseLease(readText(join(cfg.root, "control/COMMAND.md")), cfg.leaseStaleMinutes);
    const stewardId = lease?.paseoAgent ?? "";
    // Never wake on the steward's own turn: that is self-oscillation, not supervision.
    if (agentIdMatches(agent.id, stewardId)) return;
    if ((agent.title ?? "").startsWith(tickTitlePrefix(cfg.root))) return;
    const reportText = [...(event.timeline ?? [])].reverse().find(item => item.type === "assistant_message");
    if (reportText?.type === "assistant_message") {
      const parsed = parseWorkerReport(reportText.text);
      const task = reportField(reportText.text, "task_id") || /\bT-\d+\b/.exec(agent.title ?? "")?.[0];
      if (task && parsed.ok) {
        if (parsed.report.status === "DONE") {
          // The report is the event; the gate itself runs inside the existing tick. Only an R0
          // manifest is captured, and only a full commit sha can name the tree the gate must prove.
          captureR0Gate(cfg.root, {
            task,
            attempt: reportField(reportText.text, "attempt_id") || agent.id,
            agentId: agent.id,
            worktree: agent.cwd,
            commit: parsed.report.commitSha,
          });
        } else if (armed(cfg)) {
          const error = parsed.report.error;
          const code = parsed.report.waitingOnOwner ? "E_ENV"
            : /\b(E_LOGIC|E_ENV|E_FLAKY|E_UNKNOWN)\b/.exec(error)?.[1] ?? "E_UNKNOWN";
          recordTaskFailure(cfg.root, { task,
            attempt: reportField(reportText.text, "attempt_id") || agent.id,
            worktree: agent.cwd, reportId: `${agent.id}:${event.turnId ?? reportText.text}`,
            commit: parsed.report.commitSha,
            fingerprint: reportField(reportText.text, "fingerprint") || error,
            code: code as "E_LOGIC" | "E_ENV" | "E_FLAKY" | "E_UNKNOWN", at: new Date().toISOString() });
        }
      }
    }
    if (!armed(cfg)) return;
    const outcome = event.outcome.kind === "completed"
      ? "completed"
      : event.outcome.kind === "failed"
        ? `failed: ${event.outcome.error.message}`
        : `canceled: ${event.outcome.reason}`;
    const line = `- 已完工：\`${agent.id.slice(0, 7)}\` 「${agent.title ?? "未命名"}」 outcome=${outcome}`;
    const existing = wakeBuffers.get(cfg.root);
    const fresh = projectFor(cfg.root, false)!;
    updateProject(cfg.root, { pendingWakes: [...fresh.pendingWakes, { id: randomUUID(), line, at: new Date().toISOString() }] });
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      wakeBuffers.delete(cfg.root);
      void flushWake(cfg.root).catch(rememberConfigError);
    }, WAKE_QUIET_MS);
    timer.unref?.();
    wakeBuffers.set(cfg.root, timer);
  })().catch(rememberConfigError);
}

// ---------------------------------------------------------------- permission policy

/**
 * The whole policy, three cases and no more: a plan exit is allowed, a question is denied with
 * QUESTION_DENY_MESSAGE (never answered with invented content), and EVERYTHING ELSE is left pending
 * for the human. `null` means "leave pending".
 */
/** Commands that require the steward's explicit intervention. Applied to both permission paths. */
function lstatExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

/** A deliberately small shell grammar. Unsupported expansion or syntax stays pending. */
export function parseShellCommands(command: string): string[][] | null {
  const commands: string[][] = [];
  let words: string[] = [], word = "", started = false, quote = "";
  const flushWord = () => { if (started) words.push(word); word = ""; started = false; };
  const flushCommand = () => { flushWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote === "'") {
      if (c === "'") quote = ""; else word += c;
      continue;
    }
    if (c === "$" || c === "`") return null;
    if (c === "\\") {
      const next = command[++i];
      if (next === undefined) return null;
      if (quote === '"' && !['$', '`', '"', "\\", "\n"].includes(next)) word += "\\";
      if (next !== "\n") { word += next; started = true; }
      continue;
    }
    if (quote) { if (c === quote) quote = ""; else word += c; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if ("(){}<>*?[]~#".includes(c)) return null;
    if (";&|\n".includes(c)) { flushCommand(); continue; }
    if (/\s/.test(c)) { flushWord(); continue; }
    word += c; started = true;
  }
  if (quote) return null;
  flushCommand();
  if (!commands.length || commands.some(words => !words[0] || words[0].includes("="))) return null;
  return commands;
}

export function destructiveOperation(detail: string, cwd: string): string | null {
  let command = detail;
  try { const input = JSON.parse(detail); command = input.command ?? input.cmd ?? detail; } catch {}
  const commands = parseShellCommands(command);
  if (!commands) return null;
  for (const words of commands) {
    const executable = basename(words[0] ?? "");
    const args = words.slice(1);
    // A recognized destructive shell body remains prohibited even inside an interpreter.
    if (["sh", "bash", "dash", "zsh"].includes(executable) && args[0] === "-c" && args[1]) {
      const nested = destructiveOperation(args[1], cwd);
      if (nested) return nested;
    }
    // Wrappers can rebuild a command word.
    if (["time", "nohup", "timeout", "nice", "ionice", "setsid", "busybox", "sudo", "command", "cd", "pushd", "popd"].includes(executable))
      return "indirect shell execution";
    const normalized = [executable, ...args].join(" ");
    const operations: [string, RegExp][] = [
      ["git clean", /^git .*\bclean\b.*(?:--(?:force|directories|ignored|exclude)(?:\b|=)|-[a-z]*[fdx])/],
      ["git reset --hard", /^git .*\breset\b.*--hard\b/],
      ["git force push", /^git .*\bpush\b.*(?:--force(?:-with-lease)?\b|-[a-z]*f\b)/],
      ["recursive chmod", /^chmod .*(?:-R|--recursive)/],
      ["git history rewrite", /^git .*\b(?:filter-branch|filter-repo)\b/],
      ["recursive rm", /^rm .*(?:--recursive\b|-[a-zA-Z]*[rR])/],
      ["system shutdown", /^(?:shutdown|reboot)\b/],
      ["SQL DROP", /\bDROP\s+(?:DATABASE|TABLE)\b/i],
    ];
    for (const [operation, pattern] of operations) if (pattern.test(normalized)) return operation;
    if (["rm", "mv", "truncate"].includes(executable)) {
      let operandsOnly = false;
      const targets: string[] = [];
      for (const arg of args) {
        if (!operandsOnly && arg === "--") { operandsOnly = true; continue; }
        if (!operandsOnly && arg.startsWith("-")) {
          // Option arguments can contain paths (for example mv --target-directory).
          // Only well-understood rm flags are automatically handled.
          if (executable !== "rm" || !/^(?:-[fiIv]+|--force|--interactive(?:=(?:never|once|always))?|--verbose)$/.test(arg))
            return executable + " unresolved option";
          continue;
        }
        targets.push(arg);
      }
      for (const arg of targets) {
        const path = resolve(cwd, arg);
        if (/(?:^|\/)\.git(?:\/|$)/.test(path)) return "rm .git";
        try {
          const root = realpathSync(cwd);
          // Resolve the parent even when the leaf is absent; missing parents are never assumed safe.
          const parent = realpathSync(dirname(path));
          const physical = existsSync(path) || lstatExists(path) ? realpathSync(path) : join(parent, basename(path));
          if (!physical.startsWith(root + "/")) return executable + " outside worktree";
        } catch { return executable + " unresolved target"; }
      }
    }
  }
  return null;
}

/** Positive approval boundary. Declarations are exact argv, never command prefixes. */
export function safeShellCommand(detail: string, cwd: string, runners: string[][] = []): boolean {
  let command = detail;
  try { const input = JSON.parse(detail); command = input.command ?? input.cmd ?? detail; } catch {}
  const commands = parseShellCommands(command);
  if (!commands) return false;
  // Only tools that CANNOT write are on this list. Removed over five review rounds, each with a repro:
  //   sed ('1w file'), sort ('-ro file'), awk (redirect), uniq (second operand is an output file),
  //   file ('-C -m' compiles a database). The lesson is not "add another regex" - a general-purpose executable
  //   with a write mode cannot be made safe by pattern matching, so it does not belong on an auto-allow list.
  const inspection = new Set("ls cat head tail wc grep rg diff stat pwd echo printf test true false date".split(" "));
  return commands.every(words => {
    const [word, ...args] = words;
    // Absolute executable paths and ./ wrappers do not inherit a system command's trust.
    if (word.includes("/") || args.some(a => /^(?:-[ce]|--eval)(?:$|=)/.test(a))) return false;
    if (/^(?:python(?:[23](?:\.\d+)?)?|node|ruby|perl|php|sh|bash|dash|zsh)$/.test(word)) {
      if (!args[0] || args[0].startsWith("-")) return false;
      try {
        const root = realpathSync(cwd), script = realpathSync(resolve(cwd, args[0]));
        return script.startsWith(root + "/") && statSync(script).isFile();
      } catch { return false; }
    }
    if (["env", "xargs", "eval", "exec", "source", "."].includes(word)) return false;
    if (word === "git") {
      // Committing is the deliverable, not a privilege: without `git add` / `git commit` a worker cannot hand
      // anything back, and two legs stalled on exactly that (2026-10-21). Still refused: history rewriting,
      // remote writes, and anything that can execute code (hooks run on commit, but the tree is scoped).
      const readOnly = ["status", "diff", "log", "show", "rev-parse", "ls-files", "blame"];
      if (readOnly.includes(args[0])) {
        return !args.some(a => /^(?:--output|--ext-diff|--textconv)(?:$|=)/.test(a));
      }
      if (args[0] === "add") return true;
      if (args[0] === "commit") {
        // Never skip hooks, never rewrite a commit, never sign on someone's behalf.
        // `-n` is --no-verify, and it hides inside an attached cluster (`-nmovernight commit`). Anything that
        // STARTS with -n is refused, whatever follows it (review round 5, F2).
        return !args.some(a => /^(?:--no-verify|--amend|--fixup|--squash|-S|--gpg-sign)/.test(a) || /^-n/.test(a));
      }
      return args[0] === "branch" && args[1] === "-l" && args.slice(2).every(a => !a.startsWith("-"));
    }
    if (runners.some(r => r.length === words.length && r.every((w, i) => w === words[i]))) return true;
    if (!inspection.has(word)) return false;
    // Inspection tools also have execution/write modes; these are not inspection.
    if (["sed", "awk"].includes(word) && args.some(a => /(?:^-i|^--in-place|^--file|^-f|system|getline|[;{}] *[ew]\b|[>|])/.test(a))) return false;
    if (word === "sed" && args.some(a => /(?:^|[;\n])\s*[ew]\b|s(.).*\1.*\1[gew]*[ew]/.test(a))) return false;
    if (word === "find" && args.some(a => /^-(?:exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(a))) return false;
    if (word === "rg" && args.some(a => /^(?:--pre|--hostname-bin)(?:$|=)/.test(a))) return false;
    if (word === "sort" && args.some(a => /^(?:-o|--output)/.test(a))) return false;
    return true;
  });
}

export function destructiveShell(detail: string, cwd: string): boolean {
  return destructiveOperation(detail, cwd) !== null;
}

export function decide(kind: ReturnType<typeof classifyRequest>, cfg: ProjectConfig): PermissionAudit["decision"] | null {
  if (kind === "plan" && cfg.autoAllowPlanExit) return "allow";
  if (kind === "question" && cfg.autoDenyQuestions) return "deny";
  // Policy c. Without it every codex worker stalls on its first shell request and the turn never closes.
  if (kind === "shell" && cfg.autoAllowShell) return "allow";
  // Scratch in /tmp is what a worker does to run a probe. Its own project is where it should write, but a
  // pending prompt for /tmp cost two workers 25 minutes each on 2026-10-19/20. Any OTHER external path stays
  // pending: reading someone else's tree is not a scratch decision.
  if (kind === "temp" && cfg.autoAllowShell) return "allow";
  // Same switch: reading the Paseo tree is part of building against it. Any other external path stays pending.
  if (kind === "source" && cfg.autoAllowShell) return "allow";
  // A file write inside the worker's own worktree is the work. `decide` cannot see paths, so the caller resolves
  // "edit" with `decideEdit` below; reaching here means the path could not be proven inside the worktree.
  if (kind === "blocked") return "deny";
  return null;
}

/**
 * An out-of-project READ is allowed when every requested path is inside a directory the project declares as a
 * reference (`readOnlyRoots`). `/tmp` and the Paseo source keep their own classes. Anything else stays pending:
 * a worker reading a library it is reproducing is research; a worker reading someone's home is not.
 */
export function decideReference(
  cfg: ProjectConfig,
  detail: string | undefined,
): PermissionAudit["decision"] | null {
  const roots = (cfg.readOnlyRoots ?? []).map((root) => expandHome(root).replace(/\/+$/, ""));
  if (roots.length === 0) return null;
  const paths = externalPaths(detail);
  if (!paths || paths.length === 0) return null;
  const inside = (root: string, p: string) => p === root || p.startsWith(root + "/");
  return paths.every((p) => roots.some((root) => inside(root, p))) ? "allow" : null;
}

/**
 * A file write is allowed only when the target is inside the agent's own working directory.
 * Outside it — another workspace, the steward's tree, the repository at large — stays with the human.
 */
export function decideEdit(
  cfg: ProjectConfig,
  agentCwd: string | null | undefined,
  detail: string | undefined,
): PermissionAudit["decision"] | null {
  if (!cfg.autoAllowShell) return null;
  const target = filePathFrom(detail);
  if (!target || !agentCwd) return null;
  try {
    const canonical = (path: string): string => {
      try { return realpathSync(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // An existing but unresolvable symlink is uncertainty, never a new ordinary file.
        try { if (lstatSync(path).isSymbolicLink()) throw new Error("Unresolved symlink"); }
        catch (statError) { if ((statError as NodeJS.ErrnoException).code !== "ENOENT") throw statError; }
        const parent = dirname(path);
        if (parent === path) throw error;
        return join(canonical(parent), basename(path));
      }
    };
    const normalized = resolve(expandHome(agentCwd), expandHome(target));
    const resolvedTarget = canonical(normalized);
    const inside = (root: string) => {
      const rel = relative(canonical(root), resolvedTarget);
      return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
    };
    if (inside(resolve(expandHome(agentCwd)))) return "allow";
    if (!inside("/tmp")) return null;
    // /tmp is scratch, but another project may live inside it. A write into a git work tree that is not the
    // agent's own is not scratch (review round 4, F3).
    try {
      const dir = existsSync(resolvedTarget) ? resolvedTarget : dirname(resolvedTarget);
      execFileSync("git", ["-C", dir, "rev-parse", "--git-dir"], { stdio: "ignore" });
      return null;
    } catch {
      return "allow";
    }
  } catch { return null; }
}

/** The project an agent belongs to: its cwd is one of the project's workspaces (worktrees match by `project`). */
async function projectOfAgent(cwd: string): Promise<ProjectConfig | null> {
  const at = expandHome(cwd).replace(/\/+$/, "");
  const file = loadConfig();
  const ws = (await workspaceList()).find((w) => w.cwd.replace(/\/+$/, "") === at);
  return file.projects.find((p) => p.root === at || (ws !== undefined && (ws.project === basename(p.root) || ws.cwd === p.root))) ?? null;
}

function auditKey(entry: PermissionAudit): string {
  return JSON.stringify([entry.project, entry.agentId, entry.requestId, entry.attemptId || entry.at]);
}

/** Update one attempt in place. Retries get a new id and retain the earlier attempt until eviction. */
function recordAudit(entry: PermissionAudit): boolean {
  const path = configPath();
  const recovery = unsavedAudit.get(path) ?? new Map<string, PermissionAudit>();
  unsavedAudit.set(path, recovery);
  const key = auditKey(entry);
  try {
    const file = loadConfig();
    const saved = { ...entry, recorded: true, ok: entry.delivery === "confirmed" };
    const all = [saved, ...file.audit.filter((a) => auditKey(a) !== key)];
    const removed = all.slice(AUDIT_CAP);
    for (const row of removed) {
      const prior = file.auditEvictions[row.project] ?? { count: 0, lastAt: null };
      file.auditEvictions[row.project] = { count: prior.count + 1, lastAt: new Date().toISOString() };
    }
    file.audit = all.slice(0, AUDIT_CAP);
    saveConfig(file);
    recovery.delete(key);
    if (recovery.size === 0) auditErrors.delete(path);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recovery.set(key, { ...entry, delivery: entry.delivery === "prepared" ? "not-sent" : entry.delivery, recorded: false, ok: false });
    auditErrors.set(path, message);
    console.error(`[paseo-steward] audit NOT RECORDED ${entry.agentId} ${entry.requestId}: ${message}`);
    return false;
  }
}

function readAudit(root: string): Pick<StewardState["permissions"], "audit" | "auditError" | "auditRetention"> {
  const path = configPath();
  // Retry a real saved-in-memory row, including a final state whose prepared intent is already durable.
  for (const entry of [...(unsavedAudit.get(path)?.values() ?? [])]) recordAudit(entry);
  const file = loadConfig();
  const recovery = [...(unsavedAudit.get(path)?.values() ?? [])];
  const keys = new Set(recovery.map(auditKey));
  const audit = [...recovery, ...file.audit.filter((a) => !keys.has(auditKey(a)))].filter((a) => a.project === root);
  const eviction = file.auditEvictions[root];
  return {
    audit,
    auditError: auditErrors.get(path) ?? null,
    auditRetention: {
      totalCap: AUDIT_CAP, projectCap: AUDIT_CAP,
      retained: file.audit.filter((a) => a.project === root).length,
      evicted: eviction?.count ?? 0, lastEvictedAt: eviction?.lastAt ?? null,
    },
  };
}

type Respond = (response: { behavior: "allow" } | { behavior: "deny"; message: string }) => Promise<void>;
/** `deferred` is a designed outcome, not a failure: the policy left the request for the human. */
type PolicyResult = { ok: boolean; message: string; deferred?: boolean };
const activeAnswers = new Map<string, Promise<PolicyResult>>();
/** Confirmation is a snapshot, not an indefinite wait: the sweep must reach the next request. */
const CONFIRM_DEADLINE_MS = 2_000;

function confirmationWithDeadline(confirmed: () => Promise<boolean>): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), CONFIRM_DEADLINE_MS);
    try {
      confirmed().then((value) => finish(value), () => finish(false));
    } catch {
      finish(false);
    }
  });
}

/** Coalesce event/sweep races for the same agent and request. */
const lastPendingNudge = new Map<string, number>();

/** Tell the steward a worker is parked on a request the policy has no answer for. One nudge per minute. */
async function nudgeStewardAboutPending(
  cfg: ProjectConfig,
  agent: { id: string; title: string },
  request: { id?: string; name: string; detail?: string },
): Promise<void> {
  const now = Date.now();
  if (now - (lastPendingNudge.get(cfg.root) ?? 0) < 60_000) return;
  lastPendingNudge.set(cfg.root, now);
  const lease = parseLease(readText(join(cfg.root, "control/COMMAND.md")), cfg.leaseStaleMinutes);
  const steward = lease?.paseoAgent ?? "";
  if (!/^[0-9a-f]{7}/i.test(steward)) return;
  const text = [
    `【待处理权限】工人 ${agent.id.slice(0, 7)}（${agent.title}）卡在 \`${request.name}\`，请求 id \`${request.id}\`。`,
    request.detail ? `范围/说明：${request.detail.slice(0, 200)}` : "没有说明。",
    "这一类按设计必须由人回答（文件写入 / 改模式 / 授权）。你不要自己越过这条边界。",
    "两条正路：(a) 若这类请求本应按策略处理，先补分类与 checks/leg12 用例再上线；",
    "(b) 否则把它挂起，写进 output/status-one-pager.md，去推进**不受影响**的腿。",
  ].join("\n");
  try {
    await run(paseoBin(), ["agent", "send", steward, text, "--behavior", "steer", "--no-wait"], cfg.root);
    console.log(`[paseo-steward] permission ${request.name} has no answer — nudged the steward ${steward.slice(0, 7)}`);
  } catch {
    /* the steward may be gone; the ledger warning already covers that */
  }
}

async function applyPolicy(
  agent: { id: string; title: string; cwd: string },
  request: { id: string; name: string; kind?: string; input?: unknown; detail?: string },
  source: PermissionAudit["source"],
  respond: Respond,
  confirmed: () => Promise<boolean>,
): Promise<PolicyResult> {
  const key = JSON.stringify([agent.id, request.id]);
  const active = activeAnswers.get(key);
  if (active) return active;
  const operation = applyPolicyOnce(agent, request, source, respond, confirmed);
  activeAnswers.set(key, operation);
  try { return await operation; } finally { activeAnswers.delete(key); }
}

/** Validate SDK evidence independently of descriptive tool names. */
export function authoritativeRequest(request: { name: string; kind?: string; input?: unknown }): boolean {
  if (!["tool", "shell", "plan", "question"].includes(request.kind ?? "")) return false;
  if (!request.input || typeof request.input !== "object" || Array.isArray(request.input)) return false;
  const input = request.input as Record<string, unknown>;
  if (/bash|shell|exec|command/i.test(request.name)) {
    const commands = ["command", "cmd"].filter(key => key in input).map(key => input[key]);
    return (request.kind === "tool" || request.kind === "shell") && commands.length === 1
      && typeof commands[0] === "string" && commands[0].trim().length > 0;
  }
  if (/^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create_file)/i.test(request.name)) {
    const paths = ["file_path", "path", "filePath"].filter(key => key in input).map(key => input[key]);
    return request.kind === "tool" && paths.length === 1 && typeof paths[0] === "string" && paths[0].length > 0;
  }
  if (/external_directory/i.test(request.name)) return request.kind === "tool" && externalPaths(JSON.stringify(input)) !== null;
  return request.kind === "plan" && /^(ExitPlanMode|exit_plan_mode)$/.test(request.name);
}

/** Persist intent BEFORE sending. Confirmation and persistence are independent facts. */
async function applyPolicyOnce(
  agent: { id: string; title: string; cwd: string },
  request: { id: string; name: string; kind?: string; input?: unknown; detail?: string },
  source: PermissionAudit["source"],
  respond: Respond,
  confirmed: () => Promise<boolean>,
): Promise<PolicyResult> {
  const requestedAt = new Date().toISOString();
  const evidence = JSON.stringify(request.input ?? {});
  let kind = classifyRequest(request.name, request.kind, evidence);
  if (kind === "temp" || kind === "source") {
    const paths = externalPaths(evidence);
    const allowedRoot = kind === "temp" ? "/tmp" : (process.env.PASEO_SOURCE_ROOT ?? "");
    // With no configured Paseo source tree there is no containment to prove, so the request is not a `source` read.
    if (!allowedRoot) kind = "external";
    try {
      if (!allowedRoot) throw new Error("no source root");
      const canonicalRoot = realpathSync(allowedRoot);
      const contained = paths?.every((path) => {
        const target = resolve(path);
        // Resolve the target too when present, so a symlink target cannot escape.
        const canonical = existsSync(target) ? realpathSync(target)
          : join(realpathSync(dirname(target)), basename(target));
        return canonical === canonicalRoot || canonical.startsWith(canonicalRoot + "/");
      });
      if (!contained) kind = "external";
    } catch { kind = "external"; }
  }
  const cfg = await projectOfAgent(agent.cwd);
  const tag = `${agent.id.slice(0, 7)} ${request.name} (${kind})`;
  const result = (status: string, ok = false): PolicyResult => ({ ok, message: `${tag}: ${status}` });
  const deferred = (status: string): PolicyResult => ({ ok: false, deferred: true, message: `${tag}: ${status}` });
  if (!cfg) return deferred("left pending — agent is in no steward project");
  // Match the UI's onboarding test, including unreadable COMMAND.md. Local workspaces alone do not opt in.
  if (readText(join(cfg.root, "control/COMMAND.md")) === null) return deferred("left pending — project is not onboarded");
  if (kind === "shell") {
    const input = request.input as { command?: unknown; cmd?: unknown } | undefined;
    const command = input?.command ?? input?.cmd;
    if (typeof command !== "string" || !parseShellCommands(command))
      return deferred("left pending — unresolved shell syntax");
  }
  const destructive = kind === "shell" ? destructiveOperation(evidence, agent.cwd) : null;
  let decision = destructive ? "deny" : kind === "edit" ? decideEdit(cfg, agent.cwd, evidence)
    : kind === "external" ? decideReference(cfg, evidence)
    : decide(kind, cfg);
  if (decision === "allow" && (!authoritativeRequest(request)
    || kind === "shell" && !safeShellCommand(evidence, agent.cwd, cfg.safeTestRunners))) decision = null;
  if (decision === null || kind === "other") {
    // An unclassified request is a MECHANISM decision, so it goes to the steward, never silently to the
    // owner. Three times in two days a worker sat on one: CodexBash, then external_directory twice. Coalesced
    // per project so a chatty worker cannot turn this into a wake storm.
    if (kind === "other" || kind === "external") void nudgeStewardAboutPending(cfg, agent, { id: request.id, name: request.name, detail: request.detail });
    return deferred(`left pending — ${
      kind === "external" ? "an out-of-project path other than /tmp; the human decides"
      : kind === "edit" ? "a write outside the worker's own worktree; the human decides"
      : kind === "other" ? "not a plan exit, a question, a shell command, /tmp scratch or a worktree edit; the human decides"
      : "this policy is off"
    }`);
  }
  const entry: PermissionAudit = {
    attemptId: randomUUID(),
    at: new Date().toISOString(), requestedAt, project: cfg.root,
    agentId: agent.id, agentTitle: agent.title, requestId: request.id,
    request: request.name, kind, decision, source,
    delivery: "prepared", recorded: true, ok: false, error: null,
  };
  if (!recordAudit(entry)) return result(`${decision}; not recorded — answer was not sent`);
  try {
    const denyMessage = destructive ? `Denied ${destructive}. Next step: run a read-only preview and ask the steward to review the affected paths before proceeding.` : kind === "blocked"
      ? "Workers have no browser or desktop. Do not launch Chrome or any GUI. If you need a document, report its URL in your four-field report and the steward will fetch the excerpt for you."
      : QUESTION_DENY_MESSAGE;
    await respond(decision === "allow" ? { behavior: "allow" } : { behavior: "deny", message: denyMessage });
    // A returned send call may have suppressed its transport error. Only a fresh snapshot can confirm closure.
    entry.delivery = "unconfirmed";
    if (await confirmationWithDeadline(confirmed)) entry.delivery = "confirmed";
  } catch (e) {
    entry.delivery = "failed";
    entry.error = e instanceof Error ? e.message : String(e);
  }
  const recorded = recordAudit(entry);
  return result(`${decision}; ${entry.delivery}; ${recorded ? "recorded" : "not recorded"}`, recorded && entry.delivery === "confirmed");
}

/** Failure, a null response or a missing pending list is unknown, never a confirmation. */
async function confirmClosed(ref: ReturnType<PluginHookContext["paseo"]["agents"]["ref"]>, requestId: string): Promise<boolean> {
  try {
    const fresh = await ref.refresh();
    return Array.isArray(fresh?.agent.pendingPermissions) && !fresh.agent.pendingPermissions.some((r) => r.id === requestId);
  } catch { return false; }
}

/** `agent.permission_requested`: answer as the request is raised. */
export async function onPermissionRequested(
  event: PluginLifecycleEvents["agent.permission_requested"],
  context: PluginHookContext,
): Promise<void> {
  const ref = context.paseo.agents.ref(event.agent.id);
  const result = await applyPolicy(
    { id: event.agent.id, title: event.agent.title ?? "", cwd: event.agent.cwd },
    {
      id: event.request.id, name: event.request.name, kind: event.request.kind, input: event.request.input,
      // The scope lives in `description` ("Scope: /tmp/*") and sometimes in `input`. Without it the policy
      // cannot tell scratch in /tmp from reading someone else's tree, and classified this as plain external —
      // which left a worker stalled for the third time in two days.
      detail: [event.request.description ?? "", JSON.stringify(event.request.input ?? {})].join(" "),
    },
    "event",
    (response) => ref.respondToPermission({ requestId: event.request.id, response }),
    () => confirmClosed(ref, event.request.id),
  );
  console.log(`[paseo-steward] permission ${result.message}`);
}

/** Answer requests that were ALREADY pending (raised before the plugin loaded) in one project. */
async function answerPending(root: string, context: PluginHandlerContext): Promise<PolicyResult[]> {
  const state = await readSteward({ project: root });
  const results: PolicyResult[] = [];
  for (const p of state.permissions.pending) {
    const ref = context.paseo.agents.ref(p.agentId);
    const fresh = await ref.refresh().catch(() => null);
    // Cached data is insufficient: the CLI name cannot stand in for the SDK's type.
    const full = fresh?.agent.pendingPermissions?.find((r) => r.id === p.requestId);
    if (!full || !full.kind || full.input === undefined) {
      results.push({ ok: false, deferred: true, message: `${p.requestId}: left pending — authoritative snapshot unavailable` });
      continue;
    }
    const result = await applyPolicy(
      { id: p.agentId, title: p.agentName, cwd: ref.cwd ?? root },
      {
        id: p.requestId, name: full?.name ?? p.request, kind: full?.kind, input: full.input,
        detail: [full?.description ?? p.description, JSON.stringify(full?.input ?? {})].join(" "),
      },
      "sweep",
      (response) => ref.respondToPermission({ requestId: p.requestId, response }),
      () => confirmClosed(ref, p.requestId),
    );
    console.log(`[paseo-steward] permission ${result.message}`);
    results.push(result);
  }
  return results;
}


// ---------------------------------------------------------------- onboarding

/**
 * The seven onboarding gates. They are a REPORT, not a claim: a folder can be structurally onboarded
 * while the owner has not yet supplied the contract, and the report must say so.
 */
const ONBOARD_COMMIT_SUBJECT = "onboard: create steward project files";
const ONBOARD_REQUIRED_FILES = ["README.md", "AGENTS.md", "plan.md", "STATUS.md"] as const;

function stamp(): string {
  return new Date().toISOString().slice(0, 16) + "Z";
}

function samePath(left: string, right: string): boolean {
  return resolve(left).replace(/\/+$/, "") === resolve(right).replace(/\/+$/, "");
}

function ensureFile(path: string, body: string): boolean {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
  return true;
}

function onboardingFiles(root: string): Record<string, string> {
  const name = basename(root);
  const now = stamp();
  return {
    "README.md": `# ${name}\n\n> This file says what the project is for. It was created by onboarding and is a **placeholder**: the\n> owner supplies the purpose. Nothing in it is a goal.\n\n## What this is\n\nA paseo-steward project. The steward reads \`plan.md\` (contract), \`control/COMMAND.md\` (ledger) and\n\`control/RESUME.md\` (one-screen hand-over).\n\n## Status\n\nSee \`STATUS.md\` for the derived index and \`control/COMMAND.md\` for the live lease.\n`,
    "AGENTS.md": `# AGENTS — rules for agents\n\n- Read \`control/RESUME.md\` first; it is one screen. Read the lease and dispatch ledger in\n  \`control/COMMAND.md\`, then \`git log --oneline -5\`.\n- \`plan.md\` is the contract. Until the owner fills 目标 / 基线 / 验收 / 约束 it is a template, not a goal.\n- One steward per project. The lease block in \`control/COMMAND.md\` decides who that is; a claimed lease\n  means a steward exists.\n- Do not invent a goal, an acceptance command, a deadline or a constraint. The owner supplies the four\n  fields in \`plan.md\`.\n- Only four classes may go to the owner: widening authorization beyond the standing grant; changing the\n  meaning of a criterion; adding, removing or retiring a work item; changing what the project is allowed\n  to do. Everything else is decided and recorded by the agent.\n- The steward is read-only towards the project it supervises. Only its own config is written elsewhere.\n- Every report is four fields: status / commit_sha / artifact_path / error.\n`,
    "plan.md": `# plan — ${name}\n\n> **TODO(owner): this file is a template. The owner must supply 目标 / 基线 / 验收 / 约束 before any work\n> is dispatched. Do not infer them from the project name or from existing files.**\n\n## 目标 (goal)\n\nTODO(owner): one paragraph. What outcome makes this project worth doing?\n\n## 基线 (baseline)\n\nTODO(owner): the starting state, measured. Commit, metric or artifact.\n\n## 验收 (acceptance)\n\nTODO(owner): a command that exits 0 only when the goal is met.\n\n## 约束 (constraints)\n\nTODO(owner): budget, deadline, forbidden paths, compatibility or policy limits.\n`,
    "STATUS.md": `# STATUS — ${name}\n\n> Derived index, not a source of truth. Rewrite it after each state change.\n\n| item | value |\n|---|---|\n| onboarded | ${now} |\n| lease | OPEN — no steward has claimed it |\n| work in flight | none |\n| next action | the owner fills 目标 / 基线 / 验收 / 约束 in \`plan.md\` |\n`,
    "control/COMMAND.md": `# COMMAND — steward ledger\n\n> Only the steward writes this file. Rules: \`AGENTS.md\`; contract: \`plan.md\`; derived index: \`STATUS.md\`.\n\n## Lease\n\n    session=(none — open)\n    paseo-agent=(none — no steward)\n    since=${now}\n    heartbeat=${now}\n    state=open\n\n> The lease is OPEN. The first steward claims it atomically with \`mkdir control/.steward-claim\`; only the\n> winner writes \`control/.steward-claim/owner\` and rewrites this block with \`state=held\`.\n\n## Dispatch ledger\n\n| leg | status | agent | note |\n|---|---|---|---|\n| — | — | — | no work dispatched |\n\n## Handover log\n\n| at | session / agent | what |\n|---|---|---|\n| ${now} | onboard | folder onboarded; lease left OPEN for the first steward |\n`,
    "control/RESUME.md": `# RESUME — steward hand-over (one screen, read this first)\n\n> A successor reads this file + the lease and dispatch ledger in \`control/COMMAND.md\` + \`git log --oneline -5\`.\n> \`plan.md\` and \`STATUS.md\` are dictionaries: look up a section, do not read them whole.\n\n**更新时间：${now}**（who: onboard）\n\n## 一句话现状\n\nFolder onboarded by paseo-steward. No work has been dispatched. The lease is open (\`state=open\`): there is\nno steward yet.\n\n## 在跑什么\n\nNone. No agent is running.\n\n## 下一步\n\n1. The owner fills 目标 / 基线 / 验收 / 约束 in \`plan.md\` (it is a template, not a goal).\n2. A steward claims the open lease with \`mkdir control/.steward-claim\`.\n3. Dispatch the first leg from \`plan.md\`.\n\n## 阻塞 / 别碰\n\n- Blocked on the owner: \`plan.md\` has no acceptance command yet.\n- Do not invent a goal or an acceptance command.\n\n## 验收命令\n\n\`\`\`bash\n# The owner supplies the command in \`plan.md\` under 验收.\n\`\`\`\n`,
    "output/status-one-pager.md": `# Status — ${name} — ${now}\n\n> One screen for the owner. Questions only, no narrative.\n\n## 要你回话的事\n\n- \`plan.md\` needs 目标 / 基线 / 验收 / 约束. Until they exist, onboarding is reported as incomplete.\n\n## 现在\n\n- Lease: OPEN, no steward.\n- Work in flight: none.\n\n## 下一步\n\n- Fill the four fields in \`plan.md\`, then claim the lease.\n`,
  };
}

async function repoState(root: string): Promise<{ repo: boolean; commits: number; rootSubject: string }> {
  try {
    await run("git", ["rev-parse", "--git-dir"], root);
  } catch {
    return { repo: false, commits: 0, rootSubject: "" };
  }
  let commits = 0;
  try {
    commits = Number((await run("git", ["rev-list", "--count", "HEAD"], root)).trim()) || 0;
  } catch {
    commits = 0;
  }
  let rootSubject = "";
  if (commits > 0) {
    try {
      const rootSha = (await run("git", ["rev-list", "--max-parents=0", "HEAD"], root)).trim().split("\n")[0] ?? "";
      rootSubject = (await run("git", ["show", "-s", "--format=%s", rootSha], root)).trim();
    } catch {
      rootSubject = "";
    }
  }
  return { repo: true, commits, rootSubject };
}

type RawProject = Record<string, unknown>;

async function paseoProjectList(): Promise<RawProject[] | null> {
  return jsonOrNull<RawProject[]>(paseoBin(), ["project", "ls", "--json"]);
}

async function paseoWorkspaceList(): Promise<RawProject[] | null> {
  return jsonOrNull<RawProject[]>(paseoBin(), ["workspace", "ls", "--json"]);
}

function planSection(text: string, heading: RegExp): string {
  const match = heading.exec(text);
  if (!match) return "";
  const rest = text.slice((match.index ?? 0) + match[0].length);
  return (rest.split(/\n##\s/)[0] ?? "").trim();
}

async function commandRunnable(root: string, command: string): Promise<boolean> {
  const token = command.trim().replace(/^[`"']|[`"']$/g, "").split(/\s+/)[0] ?? "";
  if (!token) return false;
  if (token.includes("/")) return existsSync(resolve(root, token));
  try {
    await run("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", token], root);
    return true;
  } catch {
    return false;
  }
}

async function acceptanceGate(root: string): Promise<{ pass: boolean; detail: string }> {
  const plan = readText(join(root, "plan.md"));
  if (!plan) return { pass: false, detail: "plan.md is missing" };
  const body = planSection(plan, /^##\s*验收[^\n]*/m);
  const candidate = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("TODO") && !line.startsWith(">") && !line.startsWith("<!--"))
    .map((line) => line.replace(/^[-*]\s*/, ""))
    .find(Boolean) ?? "";
  if (!candidate) return { pass: false, detail: "plan.md has no owner-supplied acceptance command (TODO)" };
  const runnable = await commandRunnable(root, candidate);
  return runnable
    ? { pass: true, detail: `acceptance command resolves: ${candidate.slice(0, 80)}` }
    : { pass: false, detail: `acceptance command is not runnable here: ${candidate.slice(0, 80)}` };
}

async function resumeGate(root: string): Promise<{ pass: boolean; detail: string }> {
  const resume = readText(join(root, "control/RESUME.md"));
  if (!resume) return { pass: false, detail: "control/RESUME.md is missing" };
  if (resumeUpdatedAt(resume) === null) return { pass: false, detail: "control/RESUME.md has no parsable 更新时间" };
  const command = readText(join(root, "control/COMMAND.md")) ?? "";
  const lease = /##\s*Lease\s*\n([\s\S]*?)(?:\n##\s|$)/.exec(command)?.[1] ?? "";
  const state = /^\s*state=(.+)$/m.exec(lease)?.[1]?.trim() ?? "";
  if (state && !new RegExp(`state=${state.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(resume)) {
    return { pass: false, detail: `RESUME.md does not name the current lease state (${state})` };
  }
  const stale = await resumeStale(root);
  if (stale) return { pass: false, detail: `RESUME.md is ${stale.minutes} min older than the latest commit` };
  return { pass: true, detail: "RESUME.md is dated and matches the current lease" };
}

async function collectOnboardGates(root: string): Promise<OnboardGate[]> {
  const cfg = projectFor(root, false);
  const gates: OnboardGate[] = [];

  const missing = ONBOARD_REQUIRED_FILES.filter((file) => {
    const text = readText(join(root, file));
    return text === null || text.trim() === "";
  });
  gates.push({
    id: "files",
    pass: missing.length === 0,
    detail: missing.length === 0 ? ONBOARD_REQUIRED_FILES.join(", ") : `missing or empty: ${missing.join(", ")}`,
  });

  const repo = await repoState(root);
  gates.push({
    id: "git",
    pass: repo.repo && repo.commits > 0,
    detail: repo.repo
      ? repo.commits > 0
        ? `${repo.commits} commit(s) reachable from HEAD`
        : "repository exists but has no commits"
      : "not a git repository",
  });

  const projects = await paseoProjectList();
  const registered = projects?.find((row) => samePath(String(row.path ?? ""), root)) ?? null;
  gates.push({
    id: "paseo_project",
    pass: Boolean(cfg?.paseoProject) && Boolean(registered) && String(registered?.projectId ?? "") === cfg?.paseoProject,
    detail: projects === null
      ? "`paseo project ls --json` could not be read"
      : cfg?.paseoProject
        ? registered
          ? `project ${cfg.paseoProject} is registered at ${root}`
          : `config names ${cfg.paseoProject} but Paseo does not list this path`
        : "no project id captured",
  });

  const workspaces = await paseoWorkspaceList();
  const local = workspaces?.find((row) => String(row.isolation ?? "") === "local" && samePath(String(row.cwd ?? ""), root)) ?? null;
  gates.push({
    id: "workspace",
    pass: Boolean(cfg?.workspace) && Boolean(local) && String(local?.workspaceId ?? "") === cfg?.workspace,
    detail: workspaces === null
      ? "`paseo workspace ls --json` could not be read"
      : cfg?.workspace
        ? local
          ? `workspace ${cfg.workspace} is the local workspace at ${root}`
          : `config names ${cfg.workspace} but Paseo does not list a local workspace here`
        : "no workspace id captured",
  });

  gates.push({ id: "acceptance", ...(await acceptanceGate(root)) });
  gates.push({ id: "resume", ...(await resumeGate(root)) });

  const plan = readText(join(root, "plan.md")) ?? "";
  const fields = ["目标", "基线", "验收", "约束"].filter((field) => new RegExp(`^##\\s*${field}`, "m").test(plan));
  gates.push({
    id: "plan_fields",
    pass: fields.length === 4,
    detail: fields.length === 4 ? "目标 / 基线 / 验收 / 约束 are present" : `missing headings: ${["目标", "基线", "验收", "约束"].filter((f) => !fields.includes(f)).join(", ")}`,
  });

  return gates;
}

/**
 * Turn a folder into a steward project. Never overwrites an existing file, never rewrites existing git
 * history, and never re-registers a project that Paseo already knows. The seven-gate report is the
 * result: `success` is true only when every gate passes.
 */
async function onboardProject(inputRoot: string): Promise<{
  ok: boolean;
  success: boolean;
  message: string;
  gates: OnboardGate[];
  projectId: string;
  workspaceId: string;
}> {
  const raw = inputRoot.trim();
  if (!raw) {
    return { ok: false, success: false, message: "onboard needs a folder path in `project`", gates: [], projectId: "", workspaceId: "" };
  }
  const root = resolve(expandHome(raw));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { ok: false, success: false, message: `refused onboard ${root}: not a folder`, gates: [], projectId: "", workspaceId: "" };
  }

  const repo = await repoState(root);
  if (repo.repo && repo.commits > 0 && repo.rootSubject !== ONBOARD_COMMIT_SUBJECT) {
    return {
      ok: false,
      success: false,
      message: `refused onboard ${root}: it already has a git repository with ${repo.commits} commit(s) (root commit "${repo.rootSubject}") — onboarding never rewrites existing history and wrote nothing`,
      gates: await collectOnboardGates(root),
      projectId: "",
      workspaceId: "",
    };
  }

  const files = onboardingFiles(root);
  for (const [relative, body] of Object.entries(files)) ensureFile(join(root, relative), body);

  const cfg = projectFor(root);
  let projectId = cfg?.paseoProject ?? "";
  let workspaceId = cfg?.workspace ?? "";
  let gitNote = "";

  if (!repo.repo) {
    try {
      await run("git", ["init", "-b", "main"], root);
      await run("git", ["add", "-A"], root);
      await run("git", ["-c", "user.name=paseo-steward", "-c", "user.email=steward@paseo.local", "commit", "-m", ONBOARD_COMMIT_SUBJECT], root);
      gitNote = "git initialised on main with one initial commit";
    } catch (error) {
      gitNote = `git init/commit failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (repo.commits === 0) {
    gitNote = "existing repository has no commits; onboarding does not commit into an existing repository";
  } else {
    gitNote = `existing repository on ${readText(join(root, ".git/HEAD"))?.trim() ?? "HEAD"}; no git init and no new commit`;
  }

  let paseoNote = "";
  const reuseNotes: string[] = [];
  const projects = await paseoProjectList();
  const registered = projects?.find((row) => samePath(String(row.path ?? ""), root)) ?? null;
  if (registered) {
    projectId = String(registered.projectId ?? "") || projectId;
    reuseNotes.push(`project ${projectId} already registered; reused`);
  }
  if (!projectId) {
    const created = await jsonOrNull<RawProject>(paseoBin(), ["project", "create", root, "--json"], root);
    projectId = String(created?.projectId ?? "");
    if (!projectId) paseoNote = `paseo project create returned no id for ${root}`;
  } else if (!registered) {
    paseoNote = `config names project ${projectId} but Paseo does not list ${root}`;
  }

  if (projectId) {
    const workspaces = await paseoWorkspaceList();
    const local = workspaces?.find((row) => String(row.isolation ?? "") === "local" && samePath(String(row.cwd ?? ""), root)) ?? null;
    if (local) {
      workspaceId = String(local.workspaceId ?? "") || workspaceId;
      reuseNotes.push(`workspace ${workspaceId} already exists; reused`);
    } else {
      const args = ["workspace", "create", "--isolation", "local", "--path", root, "--project", projectId, "--title", "main", "--json"];
      const created = await jsonOrNull<RawProject>(paseoBin(), args, root);
      workspaceId = String(created?.workspaceId ?? "");
      if (!workspaceId) paseoNote = [paseoNote, `paseo workspace create returned no id for ${root}`].filter(Boolean).join("; ");
    }
  }

  updateProject(root, { paseoProject: projectId, workspace: workspaceId });

  const gates = await collectOnboardGates(root);
  const passed = gates.filter((gate) => gate.pass).length;
  const success = gates.length === 7 && passed === 7;
  const failed = gates.filter((gate) => !gate.pass).map((gate) => `${gate.id} (${gate.detail})`);
  const notes = [...reuseNotes, gitNote, paseoNote].filter(Boolean);
  const message = success
    ? `onboarded ${root}: all 7 gates pass (project ${projectId}, workspace ${workspaceId})${notes.length ? ` — ${notes.join("; ")}` : ""}`
    : `onboard ${root}: ${passed}/${gates.length} gates pass${failed.length ? `; open: ${failed.join("; ")}` : ""}${notes.length ? ` — ${notes.join("; ")}` : ""}`;

  return { ok: success, success, message, gates, projectId, workspaceId };
}

export async function controlSteward(input: RpcInput<typeof stewardControl>, context?: PluginHandlerContext) {
  const root = input.project ?? "";
  const needProject = (): string | null => (root ? null : "project is required for this action");
  switch (input.action) {
    case "set-workspace": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      if (!input.workspace) return { ok: false, message: "workspace is required" };
      const updated = updateProject(root, { workspace: input.workspace });
      return updated
        ? { ok: true, message: `${basename(root)} steward workspace set to ${updated.workspace}` }
        : { ok: false, message: `unknown project ${root}` };
    }
    case "set-interval": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      if (!input.intervalMinutes) return { ok: false, message: "intervalMinutes is required" };
      updateProject(root, { intervalMinutes: input.intervalMinutes });
      startTimer();
      return { ok: true, message: `${basename(root)} interval set to ${input.intervalMinutes} min` };
    }
    case "set-lazy": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      const cfg = projectFor(root, false);
      if (!cfg) return { ok: false, message: `unknown project ${root}` };
      if (input.on && !cfg.workspace) {
        return { ok: false, message: "set the steward workspace first — lazy mode would otherwise create a new workspace on every dispatch" };
      }
      // Lazy mode IS the automatic half: it turns the wheel on and off with itself.
      updateProject(root, { lazyMode: Boolean(input.on), enabled: Boolean(input.on) });
      if (input.on) startTimer();
      return { ok: true, message: `${basename(root)}: lazy mode ${input.on ? "on" : "off"}` };
    }
    case "enable":
    case "disable": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      const cfg = projectFor(root);
      if (!cfg) return { ok: false, message: `unknown project ${root}` };
      if (input.action === "enable" && !cfg.workspace) {
        return { ok: false, message: "set the steward workspace first, otherwise the tick would create a new workspace on every run" };
      }
      updateProject(root, { enabled: input.action === "enable" });
      startTimer();
      return { ok: true, message: `${basename(root)} tick ${input.action === "enable" ? "enabled" : "disabled"}` };
    }
    case "tick-now": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      const results = await tickOnce("manual", root);
      return { ok: !results.some((r) => /failed/.test(r)), message: lastTick.result ?? "no result" };
    }
    case "archive-stray": {
      const file = loadConfig();
      const archived: string[] = [];
      for (const cfg of file.projects) {
        const state = await readSteward({ project: cfg.root });
        for (const stray of state.workspaces.stewardLike.filter((w) => w.id !== cfg.workspace)) {
          try {
            await run(paseoBin(), ["workspace", "archive", stray.id], cfg.root);
            archived.push(stray.id);
          } catch {
            /* reported below */
          }
        }
      }
      return { ok: true, message: archived.length ? `archived ${archived.join(", ")}` : "no stray steward workspaces" };
    }
    case "set-policy": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      if (!input.policy || input.on === undefined) return { ok: false, message: "policy and on are required" };
      const field = input.policy === "plan" ? "autoAllowPlanExit" : input.policy === "shell" ? "autoAllowShell" : "autoDenyQuestions";
      const updated = updateProject(root, { [field]: input.on });
      return updated
        ? { ok: true, message: `${basename(root)}: ${input.policy === "plan" ? "allow plan exit" : input.policy === "shell" ? "allow shell" : "deny questions"} ${input.on ? "on" : "off"}` }
        : { ok: false, message: `unknown project ${root}` };
    }
    case "answer-pending": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      if (!context) return { ok: false, message: "answer-pending needs the daemon's Paseo client" };
      const results = await answerPending(root, context);
      // A deferral is the policy working as designed, so only real failures make the aggregate false.
      return { ok: results.every((r) => r.ok || r.deferred === true), message: results.length ? results.map((r) => r.message).join(" · ") : "nothing pending" };
    }
    case "accept": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      if (!input.task) return { ok: false, message: "task is required" };
      if (!input.commit) return { ok: false, message: "commit is required" };
      const task = input.task;
      const commit = input.commit.trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(commit)) {
        return { ok: false, message: `refused ${task}: commit must be a full 40-hex sha` };
      }
      // Acceptance is evidence, never a sentence: the artifact must exist, describe this commit, and
      // record a real command run where every command exited 0.
      const artifacts = readArtifacts(root).filter((artifact) => artifact.task === task);
      if (artifacts.length === 0) {
        return { ok: false, message: `refused ${task}: no artifact under checks/out — implemented, unverified` };
      }
      const artifact = artifacts.find((entry) => entry.sha === commit);
      if (!artifact) {
        const seen = artifacts[0]?.sha?.slice(0, 12) ?? "unknown";
        return { ok: false, message: `refused ${task}: artifact sha ${seen} does not match ${commit.slice(0, 12)}` };
      }
      if (!artifact.allCommandsPassed) {
        const detail = artifact.commands.length === 0
          ? "the artifact records no commands"
          : "aggregate verdict/scope/gate or repository commit failed, or a command exited non-zero";
        return { ok: false, message: `refused ${task}: ${detail} (${artifact.path})` };
      }
      let head: string | null = null;
      try { head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(); }
      catch { /* unreadable HEAD cannot establish applicable evidence */ }
      const current = acceptanceState(root, head).find(entry => entry.task === task);
      if (!artifact.cleanCommit || current?.sha !== commit || !current.allCommandsPassed) {
        return { ok: false, message: `refused ${task}: latest applicable evidence must pass and prove a clean committed tree (${artifact.path})` };
      }
      try {
        const row = proposeDispatchRow(root, task, artifact.path, commit);
        return { ok: true, message: row, proposedRow: row, targetPath: join(root, "control/COMMAND.md") };
      } catch (error) {
        return { ok: false, message: `refused ${task}: could not propose the dispatch-ledger row — ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    case "onboard": {
      const report = await onboardProject(input.project ?? "");
      return {
        ok: report.ok,
        success: report.success,
        message: report.message,
        gates: report.gates,
        projectId: report.projectId,
        workspaceId: report.workspaceId,
      };
    }
    case "forget-project": {
      const missing = needProject();
      if (missing) return { ok: false, message: missing };
      const file = loadConfig();
      file.projects = file.projects.filter((p) => p.root !== root);
      saveConfig(file);
      return { ok: true, message: `forgot ${root}` };
    }
    default:
      return { ok: false, message: `unknown action ${String(input.action)}` };
  }
}

export function startStewardTick(): () => void {
  const file = loadConfig();
  if (file.projects.some((p) => p.enabled)) startTimer();
  return () => {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  };
}
