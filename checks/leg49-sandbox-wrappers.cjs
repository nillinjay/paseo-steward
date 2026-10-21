const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const opencode = path.resolve('tools/sandbox/opencode-global');
const claude = path.resolve('tools/sandbox/claude-sandboxed');

// --- Part A: what each wrapper asks bubblewrap to bind -------------------------------------------------------
// A stand-in `bwrap` prints its arguments instead of creating a namespace, so these decisions are checked on any host,
// including inside another sandbox. Part B below drives the real bwrap.
const fx = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leg49-args-')));
const fxHome = path.join(fx, 'home');
const fxPaseo = path.join(fxHome, 'paseo-home');
const fxBin = path.join(fx, 'bin');
for (const dir of [fxHome, fxPaseo, fxBin]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(fxBin, 'bwrap'), '#!/bin/sh\nprintf "BWRAP %s\\n" "$*"\n', { mode: 0o755 });
const fxProbe = path.join(fx, 'probe');
fs.writeFileSync(fxProbe, '#!/bin/sh\necho "probe ran"\n', { mode: 0o755 });
const fxGit = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
const fxRepo = path.join(fx, 'repo');
execFileSync('git', ['init', '-q', fxRepo]);
fxGit(fxRepo, 'commit', '-q', '--allow-empty', '-m', 'base');
const legit = path.join(fxPaseo, 'worktrees', 'x', 'paseo-t-1');
fs.mkdirSync(path.dirname(legit), { recursive: true });
fxGit(fxRepo, 'worktree', 'add', '-q', legit);
const legitMeta = path.join(fxRepo, '.git', 'worktrees', 'paseo-t-1');
// V12-01: a worktree whose pointer says `gitdir: /`, and one that points at an ancestor of the Paseo home.
const rootPointer = path.join(fxPaseo, 'worktrees', 'x', 'paseo-t-2');
fs.mkdirSync(rootPointer, { recursive: true });
fs.writeFileSync(path.join(rootPointer, '.git'), 'gitdir: /\n');
const homePointer = path.join(fxPaseo, 'worktrees', 'x', 'paseo-t-3');
fs.mkdirSync(homePointer, { recursive: true });
fs.writeFileSync(path.join(homePointer, '.git'), `gitdir: ${fxHome}\n`);

const fxRun = (wrapper, cwd, extra = {}) => {
  const result = spawnSync('/bin/sh', [wrapper, '--flag', 'value'], {
    cwd, encoding: 'utf8',
    env: {
      ...process.env, PATH: `${fxBin}:${process.env.PATH}`, HOME: fxHome, PASEO_HOME: fxPaseo,
      PASEO_STEWARD_REAL_OPENCODE: fxProbe, PASEO_STEWARD_REAL_CLAUDE: fxProbe, ...extra,
    },
  });
  const line = result.stdout.split('\n').find((l) => l.startsWith('BWRAP ')) || '';
  const binds = [];
  const words = line.split(' ');
  for (let i = 0; i < words.length; i += 1) if (words[i] === '--bind') binds.push(words[i + 1]);
  return { ...result, binds };
};

fs.mkdirSync(path.join(fxPaseo, 'opencode-home'), { recursive: true });
const oc = fxRun(opencode, legit);
assert.equal(oc.status, 0, `opencode wrapper exit ${oc.status}: ${oc.stderr}`);
// V12-02: inside the Paseo home only the worktrees and the server's own home are writable, never the home itself.
assert.ok(oc.binds.includes(path.join(fxPaseo, 'worktrees')), 'opencode: the legs\' worktrees are writable');
assert.ok(oc.binds.includes(path.join(fxPaseo, 'opencode-home')), 'opencode: the server\'s own home is writable');
assert.ok(!oc.binds.includes(fxPaseo), 'opencode: the Paseo home as a whole is not bound writable');
const ocServer = fxRun(opencode, fxPaseo);
assert.equal(ocServer.status, 0, `opencode wrapper exit ${ocServer.status}: ${ocServer.stderr}`);
assert.ok(!ocServer.binds.includes(fxPaseo), 'opencode: started from the Paseo home itself, the home stays read-only');
assert.ok(oc.binds.includes(legitMeta), 'opencode: a real linked worktree keeps its own git metadata writable');
assert.ok(!oc.binds.includes('/'), 'opencode: a `gitdir: /` pointer never makes the root writable');
assert.ok(!oc.binds.includes(fxHome), 'opencode: a pointer at an ancestor of the Paseo home binds nothing');
assert.match(oc.stderr, /ignoring git pointer in .*paseo-t-2/, 'opencode: the refused pointer is named in one warning line');

const cl = fxRun(claude, legit);
assert.equal(cl.status, 0, `claude wrapper exit ${cl.status}: ${cl.stderr}`);
assert.ok(cl.binds.includes(legitMeta) && cl.binds.includes(path.join(fxRepo, '.git')), 'claude: a real linked worktree can commit');
// A crafted git directory git accepts (HEAD, objects, refs) is still not `<repo>/.git/worktrees/<name>`.
const crafted = path.join(fx, 'crafted');
for (const dir of ['objects', 'refs']) fs.mkdirSync(path.join(crafted, dir), { recursive: true });
fs.writeFileSync(path.join(crafted, 'HEAD'), 'ref: refs/heads/main\n');
const craftedWt = path.join(fxPaseo, 'worktrees', 'x', 'paseo-t-4');
fs.mkdirSync(craftedWt, { recursive: true });
fs.writeFileSync(path.join(craftedWt, '.git'), `gitdir: ${crafted}\n`);
const clCrafted = fxRun(claude, craftedWt);
assert.equal(clCrafted.status, 0, `claude wrapper exit ${clCrafted.status}: ${clCrafted.stderr}`);
assert.ok(!clCrafted.binds.includes('/') && !clCrafted.binds.includes(crafted), 'claude: a crafted git directory binds nothing');
assert.match(clCrafted.stderr, /not binding git metadata/, 'claude: the refusal is one warning line');
const clRoot = fxRun(claude, rootPointer);
assert.ok(!clRoot.binds.includes('/'), 'claude: a `gitdir: /` pointer never makes the root writable');

// V12-03: without bwrap, both wrappers refuse inside the Paseo home (exit 78); only opencode outside it passes through.
// This replaces the old Part B case 4, which expected opencode to run unsandboxed with a warning.
const emptyBin = path.join(fx, 'emptybin');
fs.mkdirSync(emptyBin, { recursive: true });
const noBwrap = (wrapper, cwd) => spawnSync('/bin/sh', [wrapper, '--flag', 'value'], {
  cwd, encoding: 'utf8',
  env: { PATH: emptyBin, HOME: fxHome, PASEO_HOME: fxPaseo, PASEO_STEWARD_REAL_OPENCODE: fxProbe, PASEO_STEWARD_REAL_CLAUDE: fxProbe },
});
for (const [name, wrapper] of [['opencode', opencode], ['claude', claude]]) {
  const refused = noBwrap(wrapper, legit);
  assert.equal(refused.status, 78, `${name}: no bwrap inside the Paseo home exits 78, got ${refused.status}`);
  assert.match(refused.stderr, /bwrap is not installed; refusing to run unsandboxed/, `${name}: the refusal says why`);
  assert.doesNotMatch(refused.stdout, /probe ran/, `${name}: the real binary never started`);
}
const fxOutside = path.join(fx, 'elsewhere');
fs.mkdirSync(fxOutside, { recursive: true });
const ocOutside = noBwrap(opencode, fxOutside);
assert.equal(ocOutside.status, 0, `opencode outside the Paseo home passes through, got ${ocOutside.status}: ${ocOutside.stderr}`);
assert.match(ocOutside.stdout, /probe ran/, 'opencode outside the Paseo home runs the real binary untouched');

// --- Part B: the real bubblewrap -----------------------------------------------------------------------------

const { skip, missingBwrapNamespace, missingWritableHome } = require('./preconditions.cjs');
const missingPartB = missingBwrapNamespace() ?? missingWritableHome();
if (missingPartB) skip(`${missingPartB}; Part B not run, Part A above passed`);

// Both wrappers are shell scripts, so this check drives them for real, with a stand-in binary that reports what the
// kernel lets it do. The point is not that the scripts contain certain flags; it is that a write outside the sandbox
// is refused and a write inside is accepted.

// Not under /tmp on purpose: /tmp is deliberately shared with the host (Paseo's own helpers live there), so a
// fixture in /tmp could never prove that HOME is blocked.
const tmp = fs.mkdtempSync(path.join(os.homedir(), '.leg49-'));
// A fixed path, wiped first: a leftover escape.txt from the previous run would make this check lie.
const home = path.join(os.homedir(), '.leg49-home');
fs.rmSync(home, { recursive: true, force: true });
const fakePaseoHome = path.join(home, 'paseo-home');
// A leg lives inside the Paseo home; the opencode wrapper only sandboxes there, so the fixture must too.
const repo = path.join(fakePaseoHome, 'worktrees', 'x', 'paseo-t-1');
const state = path.join(home, 'state');
for (const dir of [home, fakePaseoHome, repo, state]) fs.mkdirSync(dir, { recursive: true });
execFileSync('git', ['init', '-q', repo]);

// A stand-in for claude/opencode: it reports where it may write.
const probe = path.join(home, 'probe');
fs.writeFileSync(probe, `#!/bin/sh
echo "argv: $*"
echo ok > ./inside.txt 2>/dev/null && echo "inside=writable" || echo "inside=refused"
echo ok > ${home}/escape.txt 2>/dev/null && echo "home=writable" || echo "home=blocked"
echo ok > /etc/paseo-leg49 2>/dev/null && echo "etc=writable" || echo "etc=blocked"
`);
fs.chmodSync(probe, 0o755);

const runWrapper = (wrapper, cwd, env) =>
  execFileSync('/bin/sh', [wrapper, '--flag', 'value'], { cwd, env: { ...process.env, ...env }, encoding: 'utf8' });

// 1. Inside the Paseo home, both wrappers sandbox: the worktree is writable, the machine is not.
for (const [name, wrapper] of [['opencode', opencode], ['claude', claude]]) {
  const out = runWrapper(wrapper, repo, {
    HOME: home,
    PASEO_HOME: fakePaseoHome,
    PASEO_STEWARD_REAL_OPENCODE: probe,
    PASEO_STEWARD_REAL_CLAUDE: probe,
  });
  assert.match(out, /argv: --flag value/, `${name}: arguments pass through unchanged`);
  assert.match(out, /inside=writable/, `${name}: the worktree is writable`);
  assert.match(out, /home=blocked/, `${name}: the home directory is not writable`);
  assert.match(out, /etc=blocked/, `${name}: the system is not writable`);
  assert.ok(fs.existsSync(path.join(repo, 'inside.txt')), `${name}: the write landed where it should`);
  assert.ok(!fs.existsSync(path.join(home, 'escape.txt')), `${name}: nothing escaped`);
}

// 2. Outside the Paseo home the opencode wrapper must not interfere with the owner's own commands.
const outside = path.join(tmp, 'elsewhere');
fs.mkdirSync(outside, { recursive: true });
const plain = runWrapper(opencode, outside, { HOME: home, PASEO_HOME: fakePaseoHome, PASEO_STEWARD_REAL_OPENCODE: probe });
assert.match(plain, /home=writable/, 'a normal invocation is not sandboxed');

// 3. The escape hatches exist and are honoured: a human debugging must not be locked out.
const disabled = runWrapper(opencode, repo, {
  HOME: home, PASEO_HOME: fakePaseoHome, PASEO_STEWARD_REAL_OPENCODE: probe, PASEO_STEWARD_SANDBOX: '0',
});
assert.match(disabled, /home=writable/, 'PASEO_STEWARD_SANDBOX=0 runs untouched');

console.log('PASS leg49: both wrappers contain writes, keep the worktree usable, and stay out of the way elsewhere');
