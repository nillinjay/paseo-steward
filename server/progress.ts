import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { computeProgress, progressTaskKey, type ProgressInput, type ProgressSnapshot, type ProgressTask } from "../shared/progress";

async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

function run(bin: string, args: string[], cwd?: string): Promise<string | null> {
  return new Promise((done) => {
    execFile(bin, args, { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
      (error, stdout) => done(error ? null : stdout));
  });
}

function paseoBin(): string {
  if (process.env.PASEO_BIN) return process.env.PASEO_BIN;
  const candidates = [process.env.PASEO_CLI ?? "", join(homedir(), ".local/bin/paseo"), "/usr/local/bin/paseo", "/usr/bin/paseo"];
  try {
    for (const mount of readdirSync("/tmp").filter((name) => name.startsWith(".mount_Paseo-"))) {
      candidates.push(join("/tmp", mount, "resources/bin/paseo"), join("/tmp", mount, "paseo"));
    }
  } catch { /* Fall back to PATH. */ }
  return candidates.find((path) => path && existsSync(path)) ?? "paseo";
}

/** Stop at a sibling heading even when the section is empty. */
function section(text: string | null, title: RegExp): string[] | null {
  if (text === null) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => title.test(line));
  if (start < 0) return [];
  const depth = /^#+/.exec(lines[start]!)![0].length;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const heading = /^(#+)\s/.exec(line);
    if (heading && heading[1]!.length <= depth) break;
    body.push(line);
  }
  return body;
}

function table(lines: string[]): { header: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let header: string[] | null = null;
  for (const line of lines) {
    if (!line.trim().startsWith("|")) {
      if (header) break;
      continue;
    }
    const cells = line.trim().split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!header) header = cells;
    else rows.push(cells);
  }
  return { header: header ?? [], rows };
}

function readyQueue(text: string | null): string[] | null {
  const lines = section(text, /^##\s+Ready queue\s*$/i);
  if (lines === null) return null;
  const { header, rows } = table(lines);
  const idAt = header.findIndex((cell) => /^(leg|task|task_id|id)$/i.test(cell));
  if (idAt < 0) return [];
  return rows.map((row) => progressTaskKey(row[idAt] ?? "")).filter(Boolean);
}

function latestOutcomes(text: string | null): Map<string, string> {
  const { header, rows } = table(section(text, /^##\s+Dispatch ledger\s*$/i) ?? []);
  const idAt = header.findIndex((cell) => /^(leg|task|task_id|id)$/i.test(cell));
  const statusAt = header.findIndex((cell) => /^(status|outcome)$/i.test(cell));
  const outcomes = new Map<string, string>();
  if (idAt < 0 || statusAt < 0) return outcomes;
  for (const row of rows) {
    const id = progressTaskKey(row[idAt] ?? "");
    const status = (row[statusAt] ?? "").replace(/[*`]/g, "").trim();
    // A later dispatch/retry clears an earlier BLOCKED report for the same task.
    if (id) outcomes.set(id, /^BLOCKED\b/i.test(status) ? "BLOCKED" : /^DONE\b/i.test(status) ? "DONE" : status);
  }
  return outcomes;
}

function pendingQuestions(text: string | null): string[] | null {
  const lines = section(text, /^#{1,2}\s+(?:Pending owner questions|Owner questions|要你回话的事|待业主裁决)(?:\s*[—–-].*)?\s*$/i);
  if (lines === null) return null;
  const resolved = /\[x\]|~~|\b(?:resolved|answered|closed|accepted|decided)\b|已(?:解决|回答|裁决|关闭)/i;
  const { header, rows } = table(lines);
  if (header.length) return rows.filter((row) => !resolved.test(row.join(" ")))
    .map((row) => row[0] ?? "").filter(Boolean);
  return lines.filter((line) => /^\s*(?:[-*]\s+|\d+[.)]\s+)/.test(line) && !resolved.test(line)).map((line) => line.trim());
}

async function registry(root: string): Promise<ProgressTask[] | null> {
  let files: string[];
  try { files = await readdir(join(root, "checks/tasks")); } catch { return null; }
  const rows = await Promise.all(files.filter((name) => name.endsWith(".json")).sort().map(async (name) => {
    try {
      const row = JSON.parse(await readFile(join(root, "checks/tasks", name), "utf8"));
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      // Both forms exist in the project's task manifests; older records use the filename.
      const id = row.id ?? row.task_id ?? name.slice(0, -5);
      if (typeof id !== "string" || !id.trim()) return null;
      const outcome = typeof row.lastOutcome === "object" && row.lastOutcome !== null ? row.lastOutcome.status : row.lastOutcome;
      return {
        id,
        status: typeof row.status === "string" ? row.status : undefined,
        acceptedAt: typeof row.acceptedAt === "string" ? row.acceptedAt : null,
        lastOutcome: typeof outcome === "string" ? outcome : null,
      };
    } catch { return null; }
  }));
  // Do not present a partial registry as a complete denominator.
  return rows.some((row) => row === null) ? null : rows as ProgressTask[];
}

async function worktrees(root: string): Promise<ProgressInput["worktrees"]> {
  const text = await run(paseoBin(), ["workspace", "ls", "--json"]);
  if (text === null) return null;
  try {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows)) return null;
    return rows.filter((row) => row && row.isolation === "worktree" && (
      row.project === basename(root) || row.projectRootPath === root
    )).flatMap((row) => {
      // Task branches are named paseo/T-116; paths under the Paseo home are not project roots.
      const id = row.taskId ?? /(?:^|\/)([^/]+)$/.exec(String(row.branch ?? row.name ?? ""))?.[1];
      return typeof id === "string" && id ? [{ taskId: id }] : [];
    });
  } catch { return null; }
}

/** Read-only: no config registration, no project writes and no network calls. */
export async function collectProgressInput(root: string): Promise<ProgressInput> {
  if (!root) return {};
  root = resolve(root);
  const [planText, tasks, command, trees, questions, commitDate] = await Promise.all([
    readText(join(root, "plan.md")), registry(root), readText(join(root, "control/COMMAND.md")),
    worktrees(root), readText(join(root, "output/status-one-pager.md")),
    run("git", ["log", "-1", "--format=%cI"], root),
  ]);
  const outcomes = latestOutcomes(command);
  const committedAt = Date.parse(commitDate?.trim() ?? "");
  const age = (Date.now() - committedAt) / 3_600_000;
  return {
    planText,
    tasks: tasks?.map((task) => ({ ...task, lastOutcome: task.lastOutcome ?? outcomes.get(progressTaskKey(task.id)) ?? null })) ?? null,
    readyQueue: readyQueue(command),
    worktrees: trees,
    ownerQuestions: pendingQuestions(questions),
    staleHours: Number.isFinite(age) && age >= 0 ? age : null,
  };
}

export async function readProgress(input: { project?: string } = {}): Promise<ProgressSnapshot> {
  let root = input.project;
  if (!root) {
    try {
      const text = await readText(process.env.PASEO_STEWARD_CONFIG ?? join(homedir(), ".paseo-steward.json"));
      const config = JSON.parse(text ?? "null");
      root = config?.projects?.[0]?.root;
    } catch { /* Missing configuration is an empty project. */ }
  }
  return computeProgress(await collectProgressInput(typeof root === "string" ? root : ""));
}
