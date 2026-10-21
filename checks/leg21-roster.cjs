#!/usr/bin/env node
// LEG 21 — the roster is the only source of a model.
//
// On 2026-10-20 the steward hand-wrote `--provider claude/opus-4.6`. It does not exist; the worker died in two
// minutes with an idle status, zero commits, and one line at the end of its log. The owner's ruling: a dispatch
// may name a ROLE, never a model. These checks make that ruling mechanical.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { skip, skipPart, missingLedger, missingDaemonConfig } = require("./preconditions.cjs");

const root = join(__dirname, "..");
let failures = 0;
function check(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS  ${name}\n`);
  } catch (error) {
    failures += 1;
    process.stdout.write(`FAIL  ${name} — ${error.message}\n`);
  }
}

// Every case reads the roster. The public tree ships an example one (`"template": true`), which serves every case except
// 3, 6 and 9: those drive the owner's roster against the live daemon config, which a stranger's machine may not have
// (the path is roster.mjs's own default, so this checks what dispatch reads).
const missingRoster = missingLedger("control/roster.json", root);
if (missingRoster?.endsWith("is absent")) skip(missingRoster);
const roster = JSON.parse(readFileSync(join(root, "control/roster.json"), "utf8"));
const CONFIG_PATH = join(process.env.PASEO_HOME ?? join(require("node:os").homedir(), "code/paseo/.dev/paseo-home"), "config.json");
const liveNames = (() => {
  try { return JSON.parse(readFileSync(CONFIG_PATH, "utf8")).daemon.agentProfiles.map((p) => p.name); }
  catch { return null; }
})();
const missingLive = missingRoster ?? missingDaemonConfig(join(CONFIG_PATH, ".."));
if (missingLive) skipPart(`${missingLive}; cases 3 and 9 not run${missingRoster ? ", nor case 6" : ""}`);
const PROFILE_FIXTURE = [
  { name: "pi-总管", provider: "pi", model: "opencode-go/deepseek-v4.1-flash" },
  { name: "junior-a", provider: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
  { name: "junior-b", provider: "opencode", model: "opencode/deepseek-v4.1-flash-free" },
  { name: "senior-sol", provider: "codex", model: "gpt-6.1-sol" },
  { name: "senior-opus", provider: "claude", model: "claude-opus-5-5" },
  { name: "review-codex", provider: "codex", model: "gpt-6.1-sol" },
  { name: "review-gemini", provider: "antigravity", model: "gemini-3.8-flash-high" },
];

// 1. The roster IS the owner's employee list. Any invented name fails here — `ui` and `review-alt` were invented
//    on 2026-10-20 and neither exists in the daemon config.
check("every roster entry exists in the owner's profile list", () => {
  for (const name of roster.profiles) {
    assert.ok(PROFILE_FIXTURE.some((p) => p.name === name), `"${name}" is on the roster but not a profile`);
    const found = PROFILE_FIXTURE.find((p) => p.name === name);
    assert.ok(found.provider && found.model, `profile ${name} names no provider/model`);
  }
});

// 2. And nothing on the owner's list is missing from ours: a profile the steward forgets is a worker it cannot use.
check("no profile is missing from the roster", () => {
  for (const name of PROFILE_FIXTURE.map((p) => p.name)) {
    assert.ok(roster.profiles.includes(name), `profile "${name}" is missing from control/roster.json`);
  }
});

// 3. The live config and the roster must be the same set, or the lock is decorative.
if (!missingLive) check("the live daemon profile list equals the roster", () => {
  assert.ok(liveNames, `${CONFIG_PATH} has no readable daemon.agentProfiles`);
  assert.deepEqual([...liveNames].sort(), [...roster.profiles].sort(),
    "control/roster.json and daemon agentProfiles disagree");
});

// 4. Every role has a stated spend shape, and a narrowed profile states a cached-token ceiling.
check("every profile states its spend shape", () => {
  for (const name of roster.profiles) {
    const b = (roster.budget ?? {})[name];
    assert.ok(b, `profile ${name} has no budget entry`);
    assert.equal(typeof b.max_cached_tokens, "number", `profile ${name} has no cached-token ceiling`);
  }
});

// 5. Every routing hint points at a profile that exists.
check("routing hints name real profiles", () => {
  for (const [kind, profile] of Object.entries(roster.routing ?? {})) {
    assert.ok(roster.profiles.includes(profile), `routing ${kind} -> ${profile} does not exist`);
  }
});

// 6. Live resolution against the real daemon config, when it is readable.
if (!missingRoster) check("the live daemon config resolves every roster entry", () => {
  for (const role of roster.profiles) {
    const profile = role;
    let out;
    try {
      out = execFileSync("node", [join(root, "tools/roster.mjs"), role, root], { encoding: "utf8" }).trim();
    } catch (error) {
      assert.ok(profile.startsWith("pi-") || String(error.stderr || "").includes("no daemon config"),
        `role ${role} did not resolve: ${String(error.stderr || error.message).trim()}`);
      continue;
    }
    // roster.mjs emits JSON: a tab-separated line collapsed its empty thinking field and shipped the profile
    // name as --thinking (T-117, 2026-10-20).
    const parsed = JSON.parse(out);
    const provider = parsed.provider, model = parsed.model;
    assert.ok(provider && model, `role ${role} resolved to an empty provider/model`);
  }
});

// 7. An unknown role fails loudly instead of falling back to a default model.
check("an unknown role exits non-zero and names the alternatives", () => {
  let failed = false;
  try {
    execFileSync("node", [join(root, "tools/roster.mjs"), "designer", root], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    failed = true;
    assert.match(String(error.stderr), /not on the roster/);
    assert.match(String(error.stderr), /senior-opus/);
  }
  assert.ok(failed, "an unknown role must fail");
});

// 8. The dispatcher refuses a hand-written model. This is the lock that would have caught `claude/opus-4.6`.
check("the dispatcher refuses --provider / --model / --thinking", () => {
  const script = readFileSync(join(root, "tools/dispatch.sh"), "utf8");
  assert.match(script, /--provider --model --thinking --mode/, "the forbidden-flag list must exist");
  for (const flag of ["--provider", "--model", "--thinking"]) {
    let code = 0;
    try {
      execFileSync("bash", [join(root, "tools/dispatch.sh"), "T-999", "--role", "senior-opus", "--", flag, "x", "brief"],
        { encoding: "utf8", stdio: "pipe" });
    } catch (error) {
      code = error.status;
    }
    assert.equal(code, 4, `${flag} must be refused with exit 4, got ${code}`);
  }
});

// 9. A narrow profile cannot be handed a broad read list. The owner's finding: reading was the cost.
if (!missingLive) check("a narrow profile refuses a brief that lists many files to read", () => {
  const wide = "task_id: T-999\nread_scope: a.ts, b.ts, c.ts, d.ts\nwrite_scope: x.md\nacceptance: true\n";
  let code = 0;
  try {
    execFileSync("bash", [join(root, "tools/dispatch.sh"), "T-999", "--role", "senior-opus", "--", "--title", "x", wide],
      { encoding: "utf8", stdio: "pipe", env: { ...process.env, PASEO_BIN: "/bin/false" } });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 5, `expected exit 5, got ${code}`);
});

// 10. A dispatch with no role is refused too: silence would mean "some default model".
check("the dispatcher refuses a missing role", () => {
  let code = 0;
  try {
    execFileSync("bash", [join(root, "tools/dispatch.sh"), "T-999", "--", "--workspace", "x", "brief"],
      { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 4);
});

process.stdout.write(failures === 0 ? "\nOK\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
