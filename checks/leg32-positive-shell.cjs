const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const tmp = fs.mkdtempSync('/tmp/t149-');
const root = path.join(tmp, 'work');
fs.mkdirSync(path.join(root, 'control'), { recursive: true });
fs.writeFileSync(path.join(root, 'control/COMMAND.md'), '# Test');
fs.writeFileSync(path.join(root, 'test.py'), 'print(1)');
fs.writeFileSync(path.join(tmp, 'outside.py'), 'print(1)');
fs.symlinkSync(path.join(tmp, 'outside.py'), path.join(root, 'escape.py'));
process.env.PASEO_STEWARD_CONFIG = path.join(tmp, 'config.json');
process.env.NODE_PATH = path.resolve('node_modules'); require('node:module')._initPaths();
buildSync({ entryPoints: ['server/steward.ts'], outfile: path.join(tmp, 'server.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['@getpaseo/*'] });
const s = require(path.join(tmp, 'server.cjs'));
async function exercise(command, expected, enabled = true) {
 fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG, JSON.stringify({ projects: [{ root, workspace: 'main', autoAllowShell: enabled }], audit: [] }));
 const request = { id: command, name: 'Bash', kind: 'shell', input: { command } };
 let pending = [request]; const answers = [];
 await s.onPermissionRequested({ agent: { id: 'worker', cwd: root, title: 'test' }, request }, { paseo: { agents: { ref: () => ({ refresh: async () => ({ agent: { pendingPermissions: pending } }), respondToPermission: async ({ response }) => { answers.push(response.behavior); pending = []; } }) } } });
 assert.deepEqual(answers, expected, command);
 assert.equal(pending.length, expected.length ? 0 : 1, command);
}
(async () => {
 for (const command of ["python3 -c 'import os; os.unlink(\"/tmp/review-victim\")'", 'node --eval=42', 'bash -c true', 'python3 ../outside.py', 'python3 escape.py', 'env ls', 'xargs ls', 'npm run test', 'npx arbitrary', 'make', 'docker ps', 'unknown-command', 'git commit --amend']) await exercise(command, []);
 for (const enabled of [true, false]) {
   for (const command of ['printf \'%s\' "$PWD"', '$(echo rm) x', 'node --eval=process.exit()']) await exercise(command, [], enabled);
 }
 console.log('PASS unsupported syntax sends no answer and remains pending with autoAllowShell on and off');
 await exercise('python3 test.py', ['allow']);
 // Committing is how a worker hands work back; amending is not.
 await exercise('git add -A', ['allow']);
 await exercise('git commit -m ok', ['allow']);
 await exercise('ls && git status', ['allow']);
 await exercise('ls; rm -rf victim', ['deny']);
 assert.equal(s.safeShellCommand('npm run test', root, [['npm', 'run', 'test']]), true);
 assert.equal(s.safeShellCommand('npm run test extra', root, [['npm', 'run', 'test']]), false);
 console.log('PASS positive shell policy: unknown execution pending, contained script allowed, recursive delete refused');
})().catch(e => { console.error(e); process.exitCode = 1; });

// Committing is the deliverable. Two legs stalled because `git add`/`git commit` were not on the safe list; the
// dangerous git verbs must stay out (2026-10-21).
for (const [command, expected] of [
  ['git add -A', true],
  ['git commit -m "x"', true],
  ['git commit --amend', false],
  ['git commit --no-verify -m "x"', false],
  ['git push --force', false],
  ['git reset --hard', false],
  ['git checkout .', false],
]) {
  const got = s.safeShellCommand(JSON.stringify({ command }), root, []);
  if (got !== expected) { console.log('FAIL git: ' + command + ' -> ' + got); process.exitCode = 1; }
}

// Review round 4: inspection tools with their own write language are out, and `-n` hides --no-verify.
for (const [command, expected] of [
  ["sed 1w /tmp/out /tmp/in", false],
  ["sort -ro/tmp/out /tmp/in", false],
  ["awk {print} /tmp/in", false],
  ["git commit -n -m x", false],
  ["git commit -nm x", false],
  ["rg foo", true],
  // find left the safe list too: it can write with -fprint and execute with -exec.
  ["find . -name x", false],
]) {
  const got = s.safeShellCommand(JSON.stringify({ command }), root, []);
  assert.equal(got, expected, "round 4: " + command);
}

// Round 5: tools whose second operand is an output file are out, and `-n` attaches a message.
for (const [command, expected] of [
  ["uniq /dev/null /tmp/out", false],
  ["file -C -m /tmp/magic", false],
  ["git commit -nmovernight", false],
  ["diff a b", true],
  ["wc -l x", true],
]) {
  const got = s.safeShellCommand(JSON.stringify({ command }), root, []);
  assert.equal(got, expected, "round 5: " + command);
}
