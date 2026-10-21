#!/usr/bin/env node
// Validate a review packet against the sidecar tools/digest.sh wrote beside it, before a reviewer is paid for.
//
// Why: twice on 2026-10-21 a reviewer answered "cannot determine" because the packet lacked an engine. This exits 0
// only when the packet and <packet>.meta.json exist, at least one engine is recorded, every engine's extracted text
// is still in the packet byte for byte (found by its `## file:start-end` / `## file :: symbol` marker), and "What to
// judge" is non-empty. Each failure prints one line and exits 1.
//
// Usage: tools/review-pack-validate.mjs <packet.md>
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

function fail(message) {
  process.stderr.write(`review-pack: ${message}\n`);
  process.exit(1);
}

const packet = process.argv[2];
if (!packet) {
  process.stderr.write("usage: review-pack-validate.mjs <packet.md>\n");
  process.exit(2);
}
if (!existsSync(packet)) fail(`packet not found: ${packet}`);
const meta = `${packet}.meta.json`;
if (!existsSync(meta)) fail(`sidecar not found: ${meta} (build the packet with tools/digest.sh)`);

let sidecar;
try {
  sidecar = JSON.parse(readFileSync(meta, "utf8"));
} catch (error) {
  fail(`sidecar is not valid JSON: ${meta}: ${error.message}`);
}
if (sidecar?.judge_present !== true) fail(`sidecar ${meta} does not record judge_present: true`);
const engines = Array.isArray(sidecar?.engines) ? sidecar.engines : [];
if (engines.length === 0) fail(`sidecar ${meta} lists no engine; a packet without code cannot be judged`);

const lines = readFileSync(packet, "utf8").split("\n");
const judge = lines.find((line) => line.startsWith("**What to judge.**"));
if (!judge || judge.slice("**What to judge.**".length).trim() === "") fail(`packet ${packet} has no "What to judge" text`);

/** The header digest.sh writes for a spec: `file:10-40` (a comma accepted) or `file:symbol` in --fn mode. */
function marker(spec) {
  const file = spec.slice(0, spec.indexOf(":"));
  const tail = spec.slice(spec.lastIndexOf(":") + 1);
  const range = /^(\d+)[-,](\d+)$/.exec(tail);
  if (range) return { exact: `## ${file}:${range[1]}-${range[2]}` };
  return { prefix: `## ${file} :: ${tail} (` };
}

for (const engine of engines) {
  const spec = engine?.spec;
  if (typeof spec !== "string" || !spec.includes(":")) fail(`sidecar engine ${JSON.stringify(engine)} has no file:range spec`);
  const want = marker(spec);
  const at = lines.findIndex((line) => (want.exact ? line === want.exact : line.startsWith(want.prefix)));
  if (at < 0) fail(`engine ${spec}: marker "${want.exact ?? want.prefix}" is not in the packet`);
  if (!lines[at + 1]?.startsWith("```")) fail(`engine ${spec}: no code fence after its marker`);
  const end = lines.findIndex((line, i) => i > at + 1 && line === "```");
  if (end < 0) fail(`engine ${spec}: its code fence is never closed`);
  const body = lines.slice(at + 2, end);
  if (body.length !== engine.lines) fail(`engine ${spec}: ${body.length} lines in the packet, the sidecar recorded ${engine.lines}`);
  const sha = createHash("sha256").update(`${body.join("\n")}\n`).digest("hex");
  if (sha !== engine.sha256) fail(`engine ${spec}: extracted text changed after digest (sha256 ${sha.slice(0, 12)} != ${String(engine.sha256).slice(0, 12)})`);
}

process.stdout.write(`review-pack ok: ${packet} (${engines.length} engine${engines.length === 1 ? "" : "s"})\n`);
