#!/usr/bin/env node
"use strict";

// Executor evidence, not independent review. Commands are trusted local shell commands.
const { execFileSync, spawn } = require("node:child_process");
const { readFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { resolve, join, relative } = require("node:path");

const root = resolve(__dirname, "..");

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function runCommand({ cmd, timeoutSeconds }) {
  return new Promise((resolveResult) => {
    const start = process.hrtime.bigint();
    let tail = "";
    let timedOut = false;
    let spawnError;
    const child = spawn("/bin/sh", ["-c", cmd], {
      cwd: root,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    function append(chunk) {
      // Bound memory even when a command prints a single very long line.
      tail = (tail + chunk).slice(-256 * 1024);
    }
    child.stdout.setEncoding("utf8").on("data", append);
    child.stderr.setEncoding("utf8").on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the shell AND its descendants; a shell-only timeout leaves checks running.
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") append(`\nTimeout kill failed: ${error.message}\n`); }
    }, timeoutSeconds * 1000);
    child.on("error", (error) => { spawnError = error.message; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) append(`\nTimed out after ${timeoutSeconds} seconds\n`);
      if (spawnError) append(`\nSpawn failed: ${spawnError}\n`);
      resolveResult({
        cmd,
        exitCode: timedOut ? 124 : (code ?? 1),
        durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
        outputTail: tail.replace(/\n$/, "").split("\n").slice(-40).join("\n"),
        ...(timedOut ? { timedOut: true } : {}),
        ...(signal ? { signal } : {}),
      });
    });
  });
}

async function main() {
  const registry = JSON.parse(readFileSync(join(__dirname, "legs.json"), "utf8"));
  const id = process.argv[2];
  const leg = registry.find((entry) => entry.id === id);
  if (!leg) {
    console.error(`Unknown leg id: ${id ?? "(missing)"}. Known legs: ${registry.map((entry) => entry.id).join(", ")}`);
    process.exitCode = 2;
    return;
  }
  if (!/^[a-z0-9-]+$/.test(leg.id) || typeof leg.base !== "string" ||
      !Array.isArray(leg.writeSet) || !Array.isArray(leg.criteria) ||
      !Array.isArray(leg.commands) || leg.commands.length === 0 ||
      leg.commands.some((entry) => typeof entry.cmd !== "string" || !entry.cmd.trim() ||
        !Number.isFinite(entry.timeoutSeconds) || entry.timeoutSeconds <= 0 ||
        entry.timeoutSeconds * 1000 > 2 ** 31 - 1)) {
    throw new Error(`Invalid registry entry: ${id}`);
  }
  const sha = git("rev-parse", "HEAD");
  const startedAt = execFileSync("date", ["-u", "+%Y-%m-%dT%H:%M:%SZ"], { encoding: "utf8" }).trim();
  // Resolve the base before running commands. Missing refs must never look like an empty diff.
  const changedFiles = execFileSync("git", ["diff", "--name-only", "-z", `${leg.base}..${sha}`],
    { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const dirty = git("status", "--porcelain", "--untracked-files=all");
  const commands = [];
  if (!dirty) for (const entry of leg.commands) commands.push(await runCommand(entry));
  // Commands are trusted shell, so they can mutate the very tree they certify. The verdict must describe the
  // captured sha and the tree as it was before the commands; re-read both facts afterwards, or a command can
  // modify a file (or move HEAD) and the artifact still claims PASS for the original commit.
  const headAfter = git("rev-parse", "HEAD");
  const dirtyAfter = git("status", "--porcelain", "--untracked-files=all");
  const headChanged = headAfter !== sha;
  const treeChanged = !dirty && Boolean(dirtyAfter);
  const interrupted = [];
  if (headChanged) interrupted.push(`HEAD changed during acceptance commands (expected ${sha}, found ${headAfter})`);
  if (treeChanged) interrupted.push("Working tree changed during acceptance commands; commit the tested tree before certification");
  // A write set may declare a glob (`checks/**`) or a directory (`checks/out/`). Exact comparison turned both
  // into violations; the registry has always written them as globs.
  const inWriteSet = (file) => leg.writeSet.some((entry) => {
    if (entry.endsWith("/")) return file.startsWith(entry);
    if (!entry.includes("*")) return file === entry;
    const pattern = new RegExp(`^${entry.replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`);
    return pattern.test(file);
  });
  const scope = { pass: changedFiles.every(inWriteSet) };
  const gate = { pass: !dirty && !headChanged && !treeChanged && commands.length > 0 &&
    commands.every((entry) => entry.exitCode === 0), commands };
  git("cat-file", "-e", sha + "^{commit}");
  const verdict = scope.pass && gate.pass ? "PASS" : "FAIL";
  const artifact = { scope, gate, leg: id, sha, startedAt, verdict, commands, base: leg.base,
    reason: dirty ? "Working tree is dirty; commit the tested tree before certification"
      : (interrupted.length > 0 ? interrupted.join("; ") : null),
    writeSet: leg.writeSet, changedFiles, criteria: leg.criteria };
  const output = join(__dirname, "out", `${id}-${sha}.json`);
  mkdirSync(join(__dirname, "out"), { recursive: true });
  writeFileSync(output, JSON.stringify(artifact, null, 2) + "\n");
  console.log(relative(root, output));
  process.exitCode = verdict === "PASS" ? 0 : 1;
}

main().catch((error) => {
  console.error(`Acceptance runner failed: ${error.message}`);
  process.exitCode = 1;
});
