// What a check needs from the tree under test or from this machine, and the one line it prints when that is missing.
//
// The public tree (tools/build-public-tree.sh) carries templates instead of the ledger and no task fixtures, and a
// stranger's machine has no Paseo daemon. A check whose precondition is absent prints `SKIP <check>: <what is missing>`
// and passes; a check whose precondition is present asserts exactly as before. Every helper returns null when the
// precondition holds and the missing thing, in words, when it does not. A malformed file is not "missing": it throws,
// and the check fails.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const checkName = () => path.basename(require.main?.filename ?? "check", ".cjs");

/** Print the skip line for part of a check; the rest of the check still asserts. */
function skipPart(reason, check = checkName()) {
  console.log(`SKIP ${check}: ${reason}`);
}

/** Print the skip line and pass: nothing this check asserts can run here. */
function skip(reason, check = checkName()) {
  skipPart(reason, check);
  process.exit(0);
}

/**
 * plan.md, control/COMMAND.md, control/roster.json: the public build writes templates in their place. A markdown
 * template says "(template)" in its title; a JSON template carries `"template": true`.
 */
function missingLedger(rel, root = ROOT) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return `${rel} is absent`;
  const text = fs.readFileSync(file, "utf8");
  const template = rel.endsWith(".json") ? JSON.parse(text).template === true : /^#[^\n]*\(template\)/.test(text);
  return template ? `${rel} is the public template, not this project's ledger` : null;
}

/** A task fixture in checks/tasks/ (the public tree ships only example manifests). */
function missingTask(id, root = ROOT) {
  const rel = `checks/tasks/${id}.json`;
  return fs.existsSync(path.join(root, rel)) ? null : `no task manifest ${rel}`;
}

/** HEAD of the tree under test — not of a repository that happens to contain it — or null. */
function headCommit(root = ROOT) {
  const git = (...args) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel");
  if (top.status !== 0 || fs.realpathSync(top.stdout.trim()) !== fs.realpathSync(root)) return null;
  const head = git("rev-parse", "--verify", "HEAD^{commit}");
  return head.status === 0 ? head.stdout.trim() : null;
}

/** The daemon config. `home` defaults to ${PASEO_HOME:-$HOME/.paseo}. */
function missingDaemonConfig(home = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo")) {
  const file = path.join(home, "config.json");
  return fs.existsSync(file) ? null : `no daemon config at ${file}`;
}

/**
 * bubblewrap able to create a namespace. Installed is not enough: a host that forbids unprivileged user namespaces
 * (Ubuntu's AppArmor default, CI runners, an agent already inside a sandbox) refuses before any policy is applied, so
 * nothing about the wrappers can be observed there. Any other bwrap failure is not a missing precondition.
 */
function missingBwrapNamespace() {
  const probe = spawnSync("bwrap", ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--unshare-pid",
    "--die-with-parent", "--", "true"], { encoding: "utf8", timeout: 30000 });
  if (probe.error?.code === "ENOENT") return "bwrap is not installed";
  if (probe.status !== 0 && /create new namespace|new namespace failed|setting up uid map/i.test(probe.stderr ?? "")) {
    return `bwrap cannot create a namespace on this host (${probe.stderr.trim().split("\n")[0]})`;
  }
  return null;
}

/** A writable home directory, for fixtures that must not live under the shared /tmp. */
function missingWritableHome() {
  try {
    fs.rmSync(fs.mkdtempSync(path.join(os.homedir(), ".steward-probe-")), { recursive: true, force: true });
    return null;
  } catch (error) {
    return `${os.homedir()} is not writable (${error.code})`;
  }
}

module.exports = {
  skip, skipPart, missingLedger, missingTask, headCommit, missingDaemonConfig, missingBwrapNamespace, missingWritableHome,
};
