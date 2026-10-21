import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export type ProgressSegment = {
  key: "accepted" | "inReview" | "inFlight" | "queued" | "blocked";
  count: number;
};

export type ProgressSnapshot = {
  basis: "milestones" | "legs";
  percent: number;
  segments: ProgressSegment[];
  milestones: { total: number; done: number } | null;
  legs: { accepted: number; open: number };
  attention: { blocked: number; ownerQuestions: number; staleHours: number | null };
  estimated: boolean;
  label: string;
};

export type ProgressTask = {
  id: string;
  status?: string;
  acceptedAt?: string | null;
  /** Only the latest outcome, never a count of historical reports. */
  lastOutcome?: string | null;
};

export type ProgressInput = {
  planText?: string | null;
  tasks?: ProgressTask[] | null;
  readyQueue?: string[] | null;
  /** Already scoped to this project by the collector. Unknown task IDs add no legs. */
  worktrees?: { taskId: string }[] | null;
  ownerQuestions?: string[] | null;
  /** Age of the latest recorded project commit; null when it cannot be read. */
  staleHours?: number | null;
};

export function progressTaskKey(id: string): string {
  return id.replace(/[*`]/g, "").trim().replace(/\s+/g, "-").toUpperCase();
}

/** A later declaration of the same milestone ID replaces the earlier checkbox. */
function milestonesIn(text: string | null | undefined): ProgressSnapshot["milestones"] {
  const milestones = new Map<string, boolean>();
  let inside = false;
  let fence: string | null = null;
  for (const line of (text ?? "").split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    if (/^#{1,2}\s+/.test(line)) inside = /^##\s+Milestones\s*#*\s*$/i.test(line);
    if (!inside) continue;
    const match = /^\s*-\s+\[([ xX])\]\s+(M\d+)\b/.exec(line);
    if (match) milestones.set(match[2]!.toUpperCase(), match[1]!.toLowerCase() === "x");
  }
  return milestones.size ? {
    total: milestones.size,
    done: [...milestones.values()].filter(Boolean).length,
  } : null;
}

/** Current state only: each registered or queued leg belongs to exactly one segment. */
export function computeProgress(input: ProgressInput = {}): ProgressSnapshot {
  // A manifest is a RECORD of a leg that was attempted, not a backlog item. Counting every manifest as "queued"
  // made the queue grow every time a review or a repair was dispatched (owner: "排队的越做越多",
  // 2026-10-20). The denominator is: accepted legs + work that is actually open (Ready queue and live
  // worktrees). A manifest that is neither accepted nor open is history and does not count.
  const manifests = new Map<string, ProgressTask>();
  for (const task of input.tasks ?? []) {
    const key = progressTaskKey(task.id);
    if (key) manifests.set(key, task);
  }
  // Selected = accepted legs (the numerator) + work that is actually open (the Ready queue and live worktrees).
  // Metadata always comes from the manifest when one exists, otherwise a queued id would lose its BLOCKED outcome.
  const tasks = new Map<string, ProgressTask>();
  const accepted = new Set<string>();
  for (const [key, task] of manifests) {
    const status = (task.status ?? "").replace(/[\s_-]/g, "").toLowerCase();
    if (task.acceptedAt || status === "accepted") {
      accepted.add(key);
      tasks.set(key, task);
    }
  }
  for (const id of input.readyQueue ?? []) {
    const key = progressTaskKey(id);
    if (key && /^[A-Z]+-?\d+$/.test(key) && !tasks.has(key)) tasks.set(key, manifests.get(key) ?? { id: key });
  }
  for (const tree of input.worktrees ?? []) {
    const key = progressTaskKey(tree.taskId);
    if (key && /^[A-Z]+-?\d+$/.test(key) && !tasks.has(key)) tasks.set(key, manifests.get(key) ?? { id: key });
  }
  const live = new Set((input.worktrees ?? []).map((w) => progressTaskKey(w.taskId)));
  const counts = { accepted: 0, inReview: 0, inFlight: 0, queued: 0, blocked: 0 };
  for (const [key, task] of tasks) {
    const status = (task.status ?? "").replace(/[\s_-]/g, "").toLowerCase();
    const outcome = (task.lastOutcome ?? "").trim().toUpperCase();
    if (task.acceptedAt || status === "accepted") counts.accepted++;
    else if (outcome === "BLOCKED" || (!outcome && status === "blocked")) counts.blocked++;
    else if (live.has(key)) {
      if (["inreview", "review", "readyforreview"].includes(status) || outcome === "DONE") counts.inReview++;
      else counts.inFlight++;
    } else counts.queued++;
  }
  const milestones = milestonesIn(input.planText);
  const basis = milestones ? "milestones" : "legs";
  const total = tasks.size;
  const denominator = milestones?.total ?? total;
  const numerator = milestones?.done ?? counts.accepted;
  let label = denominator === 0
    ? "There is nothing to measure yet."
    : milestones
      ? `${milestones.done} of ${milestones.total} milestones are complete.`
      : `${counts.accepted} of ${total} legs are accepted; progress is estimated.`;
  const missing = [
    input.planText == null ? "plan" : "",
    input.tasks == null ? "task registry" : "",
    input.readyQueue == null ? "Ready queue" : "",
    input.worktrees == null ? "live worktrees" : "",
    input.ownerQuestions == null ? "owner questions" : "",
  ].filter(Boolean);
  if (missing.length) label = label.replace(/\.$/, `; unavailable: ${missing.join(", ")}.`);
  const age = input.staleHours;
  return {
    basis,
    percent: denominator === 0 ? 0 : Math.round(numerator / denominator * 1000) / 10,
    segments: (Object.keys(counts) as ProgressSegment["key"][]).map((key) => ({ key, count: counts[key] })),
    milestones,
    legs: { accepted: counts.accepted, open: total - counts.accepted },
    attention: {
      blocked: counts.blocked,
      ownerQuestions: new Set(input.ownerQuestions ?? []).size,
      staleHours: age != null && Number.isFinite(age) && age >= 0 ? Math.round(age * 10) / 10 : null,
    },
    estimated: basis === "legs",
    label,
  };
}

export const ProgressSnapshotSchema = z.object({
  basis: z.enum(["milestones", "legs"]),
  percent: z.number().min(0).max(100),
  segments: z.array(z.object({
    key: z.enum(["accepted", "inReview", "inFlight", "queued", "blocked"]),
    count: z.number().int().nonnegative(),
  })),
  milestones: z.object({ total: z.number().int().nonnegative(), done: z.number().int().nonnegative() }).nullable(),
  legs: z.object({ accepted: z.number().int().nonnegative(), open: z.number().int().nonnegative() }),
  attention: z.object({
    blocked: z.number().int().nonnegative(),
    ownerQuestions: z.number().int().nonnegative(),
    staleHours: z.number().nonnegative().nullable(),
  }),
  estimated: z.boolean(),
  label: z.string(),
});

export const progressGet = defineRpc({
  name: "progress.get",
  input: z.object({ project: z.string().optional() }),
  output: ProgressSnapshotSchema,
});
