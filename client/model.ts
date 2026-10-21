import type { DispatchRow, LiveAgent, StewardState } from "../shared/steward";
import type { Tone } from "./design";
import { S } from "./strings";

/**
 * Pure derivations from `StewardState`. Every function here answers a CURRENT-state question; none of
 * them counts history. This is the one place the two facts the pill shows are defined.
 */

export type StewardStatusKind = "loading" | "none" | "clock" | "gone" | "working" | "idle";

export interface StewardStatus {
  kind: StewardStatusKind;
  tone: Tone;
  /** Filled dot when a steward is alive and has work out; a ring otherwise. */
  filled: boolean;
  /** One or two words. */
  label: string;
  /** One short clause of evidence for the label. */
  detail: string;
}

/**
 * The workers running NOW: agents the daemon reports as running in this project's workspaces, steward
 * sessions excluded. Every surface that says "running" reads this, never the dispatch ledger.
 */
export function workersRunning(state: StewardState | undefined): LiveAgent[] {
  return state?.liveAgents ?? [];
}

/**
 * The RECORD's view: a dispatch row whose status still says dispatched/running and that is neither done
 * nor flagged blocked. A finished leg whose row was not updated still matches, so this is never called
 * "running"; it is shown only as what the ledger claims.
 */
export function isInFlightInRecord(row: DispatchRow): boolean {
  return !row.done && !row.blockedInRecord && /\b(dispatched|running)\b/i.test(row.status);
}

export function inFlightInRecord(state: StewardState | undefined): DispatchRow[] {
  return state?.dispatch.filter(isInFlightInRecord) ?? [];
}

/** A CJK-ready age phrase, e.g. "6 minutes ago", "under a minute", "unknown". */
export function ago(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return S.status.agoUnknown;
  if (minutes < 1) return S.status.agoUnderMinute;
  if (minutes < 90) return S.status.agoMinutes(minutes);
  const hours = Math.round(minutes / 60);
  return hours < 48 ? S.status.agoHours(hours) : S.status.agoDays(Math.round(hours / 24));
}

export const NOT_ONBOARDED: StewardStatus = {
  kind: "none",
  tone: "muted",
  filled: false,
  label: S.status.notOnboarded.label,
  detail: S.status.notOnboarded.detail,
};

/** Manual takeover changes timing only. Unknown presence never authorizes a replacement. */
export function canTakeOver(state: StewardState | undefined): boolean {
  if (!state?.onboarded || !state.config.enabled || !state.config.workspace) return false;
  return !state.lease?.claimed || (state.agentsReadable && !state.lease.agentPresent);
}

/** The server's stale-brief warning. A successor reads the brief as CURRENT state, so it belongs beside the lease. */
export function staleBriefWarning(state: StewardState): string | null {
  return state.warnings.find((w) => /^RESUME\.md is older than the latest commit/.test(w)) ?? null;
}

/** Append the stale-brief fact to a lease-status detail. The warning already exists; this only surfaces it. */
function withBrief(detail: string, state: StewardState): string {
  const stale = staleBriefWarning(state);
  return stale ? `${detail} · ${plain(stale)}` : detail;
}

/** Answers "is the steward alive", from the lease alone. */
export function stewardStatus(state: StewardState | undefined): StewardStatus {
  if (!state) {
    return { kind: "loading", tone: "muted", filled: false, label: S.status.loading.label, detail: S.status.loading.detail };
  }
  if (!state.onboarded) return NOT_ONBOARDED;
  const reservation = state.spawnReservation;
  if (state.config.takeoverError || (reservation && reservation.reconciliation !== "verified-claim")) {
    return { kind: "clock", tone: "warning", filled: false, label: "交接待核实",
      detail: withBrief(state.config.takeoverError ?? `启动预约尚未核实：${reservation!.reconciliation}；代理 ${reservation!.agentId ?? "未知"}；继续暂停派工。`, state) };
  }
  const lease = state.lease;
  if (!lease) {
    return { kind: "none", tone: "muted", filled: false, label: S.status.noSteward.label, detail: S.status.noSteward.detail };
  }
  // The owner's rule: a claimed lease IS a steward. The heartbeat is recency, never existence, so an old
  // heartbeat must not read as "lost" — that is what used to make the wheel start a duplicate.
  // An unreadable agent list is UNKNOWN, never absence: the panel called a live steward gone when the CLI
  // disappeared from PATH after an app upgrade.
  if (!state.agentsReadable) {
    return { kind: "clock", tone: "warning", filled: Boolean(lease.claimed), label: S.status.unreadable.label, detail: withBrief(S.status.unreadable.detail, state) };
  }
  if (!lease.claimed) {
    return { kind: "none", tone: "warning", filled: false, label: S.status.unclaimed.label, detail: withBrief(S.status.unclaimed.detail, state) };
  }
  if (!lease.agentPresent) {
    return { kind: "gone", tone: "warning", filled: false, label: S.status.gone.label, detail: withBrief(state.config.takeoverError ?? S.status.gone.detail(lease.paseoAgent.slice(0, 7)), state) };
  }
  if (lease.heartbeatInFuture) {
    return { kind: "clock", tone: "warning", filled: true, label: S.status.clock.label, detail: withBrief(S.status.clock.detail, state) };
  }
  const permissionWarning = !state.permissions.readable ? "权限状态无法读取"
    : state.permissions.auditError ? state.permissions.auditError
    : state.permissions.pending.length > 0 ? "有工作会话等待权限答复" : null;
  const working = workersRunning(state).length > 0;
  return {
    kind: working ? "working" : "idle",
    tone: permissionWarning || state.config.pendingWakes?.length || state.dispatchLock ? "warning" : "success",
    filled: working,
    label: working ? S.status.aliveBusy : S.status.alive,
    detail: withBrief(permissionWarning ?? state.warnings.find((w) => /^(pending completion delivery:|dispatch reservation:)/.test(w)) ?? S.status.aliveDetail(ago(lease.heartbeatAgeMinutes), lease.claimed ? lease.paseoAgent.slice(0, 7) : ""), state),
  };
}

/** Answers "how many workers are running under it". */
export function workersLabel(n: number): string {
  return S.status.workers(n);
}

/** The pill's text: one word, plus a count only when something is running. */
export function pillLabel(n: number): string {
  return S.status.pill(n);
}

/** Markdown table cells carry `**` and backticks; the UI shows plain text. */
export function plain(text: string): string {
  return text.replace(/\*+/g, "").replace(/`/g, "").trim();
}

/** `employee **\`senior-sol\`** = codex/…` → `senior-sol`. Falls back to the first words. */
export function shortEmployee(text: string): string {
  const named = /`([^`]+)`/.exec(text);
  if (named) return named[1]!;
  return plain(text).split(/\s+/).slice(0, 3).join(" ");
}

export function projectName(root: string | null | undefined): string {
  if (!root) return S.common.ellipsis;
  return root.replace(/\/+$/, "").split("/").pop() || root;
}

/**
 * The project's own name. A directory stamp such as `20261018_` is a date, not a name, so it is
 * stripped before the title is rendered; the absolute path stays available as a caption.
 */
export function shortProjectName(name: string | null | undefined): string {
  if (!name) return "";
  const base = projectName(name);
  return base.replace(/^\d{8}_/, "") || base;
}

/** A live agent's title, shortened the way a leg is: `leg22 M3 successor: …` → `leg22 M3 successor`. */
export function shortAgent(agent: LiveAgent): string {
  return plain(agent.name).split(/:\s|\s+[(—–]|\s+-\s+/)[0]!.trim() || agent.id.slice(0, 7);
}

/** `leg 22 (\`M3\` successor: …)` → `leg 22`. The screen shows the full name. */
export function shortLeg(leg: string): string {
  return plain(leg).split(/\s+[(—–]|\s+-\s+/)[0]!.trim();
}
