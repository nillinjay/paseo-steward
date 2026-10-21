const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leg47-'));
const grantsFile = path.join(tmp, 'grants.json');
process.env.PASEO_STEWARD_GRANTS = grantsFile;
process.env.NODE_PATH = path.resolve('node_modules'); require('node:module').Module._initPaths();
for (const name of ['shared', 'server']) {
  buildSync({
    entryPoints: [name === 'shared' ? 'shared/grants.ts' : 'server/grants.ts'],
    bundle: true, platform: 'node', format: 'cjs', external: ['@getpaseo/*'],
    outfile: path.join(tmp, `${name}.cjs`),
  });
}
const shared = require(path.join(tmp, 'shared.cjs'));
const server = require(path.join(tmp, 'server.cjs'));
const HOME = '/home/example';
const WT = '/home/example/.paseo/worktrees/abcd1234/paseo-t-900';

// --- the provider table: narrowing only, and nothing invented for a provider we do not know ---------------
const codexReview = shared.grantOptions('codex', 'review', WT, HOME);
// A reviewer must write its verdict, so the sandbox is worktree-write either way; what narrows a reviewer is the
// disabled web search and the gate's write-scope check (one file).
assert.equal(codexReview.sandbox_mode, 'workspace-write');
assert.equal(codexReview.approval_policy, 'never');
assert.equal(codexReview.web_search, 'disabled');
assert.deepEqual(codexReview.sandbox_workspace_write.writable_roots, [WT], 'a reviewer writes inside its worktree, nowhere else');

const codexImpl = shared.grantOptions('codex', 'implement', WT, HOME);
assert.equal(codexImpl.sandbox_mode, 'workspace-write');
assert.deepEqual(codexImpl.sandbox_workspace_write.writable_roots, [WT], 'the writable root is the leg worktree, never the project');
assert.equal(codexImpl.sandbox_workspace_write.network_access, false);

const opencodeImpl = shared.grantOptions('opencode', 'implement', WT, HOME);
assert.equal(opencodeImpl.permission.edit, 'allow', 'editing stops asking');
assert.equal(opencodeImpl.permission.external_directory, 'deny');
assert.equal(opencodeImpl.permission.webfetch, 'deny');
assert.equal(opencodeImpl.permission.bash, 'ask', 'no OS sandbox means the shell stays a question');

const opencodeReview = shared.grantOptions('opencode', 'review', WT, HOME);
assert.equal(opencodeReview.permission.external_directory, 'deny');
assert.equal(opencodeReview.permission.websearch, 'deny', 'a reviewer does not search the web');

const claudeImpl = shared.grantOptions('claude', 'implement', WT, HOME);
assert.equal(claudeImpl.sandbox.enabled, true);
assert.equal(claudeImpl.sandbox.failIfUnavailable, true, 'a sandbox that cannot start must fail, not silently fall back');
assert.equal(claudeImpl.sandbox.allowUnsandboxedCommands, false);
assert.deepEqual(claudeImpl.sandbox.filesystem.allowWrite, [WT]);
assert.ok(claudeImpl.sandbox.filesystem.denyRead.some((p) => p.endsWith('/.ssh')));
assert.equal(claudeImpl.sandbox.autoAllowBashIfSandboxed, true, 'inside a real sandbox a command needs no click');

assert.equal(shared.grantOptions('warp-drive', 'implement', WT, HOME), null, 'an unknown provider gets no opinion');
assert.equal(shared.grantOptions('opencode', 'implement', WT, HOME).permission.bash, 'ask', 'never a blanket allow');

// --- the registry the dispatcher really writes ------------------------------------------------------------
execFileSync(process.execPath, ['tools/grant.cjs', 'T-900', 'implement', 'junior-a', 'opencode', WT, '--token', 'tok-900'], { env: process.env });
const recorded = server.readGrants();
assert.equal(recorded.length, 1);
assert.equal(recorded[0].task, 'T-900');
assert.equal(recorded[0].token, 'tok-900', 'the dispatcher records the token with the grant');
// V12-04: a grant without a token is refused at the source.
assert.throws(() => execFileSync(process.execPath, ['tools/grant.cjs', 'T-900', 'implement', 'junior-a', 'opencode', WT], { stdio: 'pipe' }), 'grant.cjs requires --token');

// Writes from the dispatcher are read back by the plugin's own reader.
assert.equal(shared.grantFor(recorded, WT).task, 'T-900');
assert.equal(shared.grantFor(recorded, WT + '/').task, 'T-900', 'a trailing slash is one worktree, not two');

// --- the hook ---------------------------------------------------------------------------------------------
let handler = null;
server.registerGrants({ before: (name, fn) => { assert.equal(name, 'agent.create'); handler = fn; return () => {}; } }, HOME);
assert.ok(handler, 'the hook is registered');

const juniorRequest = { config: { provider: 'opencode/opencode/x', cwd: WT, providerOptions: { existing: 1 } } };
const applied = handler({ request: juniorRequest });
assert.equal(applied.config.providerOptions.permission.edit, 'allow');
assert.equal(applied.config.providerOptions.existing, 1, 'options the caller already set are kept');

// An agent the steward never dispatched keeps exactly the behaviour it had.
const stranger = { config: { provider: 'opencode/opencode/x', cwd: '/home/example/elsewhere' } };
assert.equal(handler({ request: stranger }), stranger, 'no grant, no change');

// A stale grant is not a grant: the worktree may have been reused a week later.
fs.writeFileSync(grantsFile, JSON.stringify({ grants: [{ task: 'T-901', role: 'review', profile: 'review-codex', provider: 'codex', cwd: WT, at: '2026-01-01T00:00:00Z' }] }));
const stale = { config: { provider: 'codex/gpt-5', cwd: WT } };
assert.equal(handler({ request: stale }), stale, 'a grant older than the TTL does not apply');

// Reviewer role comes from the dispatcher, and a reviewer on codex gets a read-only sandbox even when the leg's
// worktree name says nothing about reviewing.
execFileSync(process.execPath, ['tools/grant.cjs', 'T-902', 'review', 'review-codex', 'codex', WT, '--token', 'tok-902'], { env: process.env });
const reviewApplied = handler({ request: { config: { provider: 'codex/gpt-5', cwd: WT } } });
assert.equal(reviewApplied.config.providerOptions.web_search, 'disabled');
assert.equal(reviewApplied.config.providerOptions.approval_policy, 'never');

// Two dispatches of one worktree must not leave two contradictory records.
execFileSync(process.execPath, ['tools/grant.cjs', 'T-902', 'review', 'review-codex', 'codex', WT, '--token', 'tok-902'], { env: process.env });
assert.equal(server.readGrants().filter((g) => g.task === 'T-902').length, 1, 'one worktree, one record');

// --- V12-04: a name is not an identity ---------------------------------------------------------------------
// The review's reproduction: a grant for /trusted/project/paseo-t-100, requested from an unrelated directory with the
// same final segment. Without the token inside that directory there is no grant.
const now = Date.now();
const trusted = { task: 'T-100', role: 'review', profile: 'reviewer', provider: 'codex', cwd: '/trusted/project/paseo-t-100', at: new Date(now).toISOString(), token: 'tok-100' };
const noToken = () => null;
assert.equal(shared.grantFor([trusted], '/tmp/unrelated/paseo-t-100', noToken), null, 'a basename alone is not a grant');
assert.equal(shared.grantFor([trusted], '/tmp/unrelated/paseo-t-100', () => 'tok-other'), null, 'a wrong token is not a grant');
assert.equal(shared.grantFor([trusted], '/tmp/unrelated/paseo-t-100', () => 'tok-100').task, 'T-100', 'the dispatcher\'s token in the worktree is');
assert.equal(shared.grantFor([trusted], '/trusted/project/paseo-t-100', noToken).task, 'T-100', 'the exact path needs no file');
const { token: _dropped, ...legacy } = trusted;
assert.equal(shared.grantFor([legacy], '/tmp/unrelated/paseo-t-100', () => 'anything'), null, 'a record without a token matches its exact path only');
// Timestamps are part of the identity: unparseable and future grants are refused.
assert.equal(shared.grantFor([{ ...trusted, at: 'not a date' }], trusted.cwd, noToken), null, 'an unparseable timestamp is not a grant');
assert.equal(shared.grantFor([{ ...trusted, at: new Date(now + 60 * 60 * 1000).toISOString() }], trusted.cwd, noToken), null, 'a future grant is not a grant');
// The hook reads the real token file.
const tokenLeg = path.join(tmp, 'elsewhere', 'paseo-t-100');
fs.mkdirSync(tokenLeg, { recursive: true });
fs.writeFileSync(grantsFile, JSON.stringify({ grants: [trusted] }));
const spoof = { config: { provider: 'codex/gpt-5', cwd: tokenLeg } };
assert.equal(handler({ request: spoof }), spoof, 'the hook refuses a basename match without .steward-grant');
fs.writeFileSync(path.join(tokenLeg, '.steward-grant'), 'tok-100\n');
assert.equal(handler({ request: spoof }).config.providerOptions.web_search, 'disabled', 'the hook accepts it once the token is there');

// The dispatcher itself: it creates the worktree, writes the token into it, records the grant against the exact path,
// and only then starts the agent in that workspace. Driven for real against a throwaway repo and a stand-in paseo.
{
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leg47-dispatch-')));
  const stewardRepo = path.join(d, 'steward');
  fs.mkdirSync(path.join(stewardRepo, 'control'), { recursive: true });
  fs.cpSync('tools', path.join(stewardRepo, 'tools'), { recursive: true });
  fs.cpSync('control/roster.json', path.join(stewardRepo, 'control', 'roster.json'));
  fs.mkdirSync(path.join(stewardRepo, 'checks', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(stewardRepo, 'checks', 'tasks', 'T-960.json'), JSON.stringify({ task_id: 'T-960', allowed_commands: ['npx tsc --noEmit', 'rm -rf*'] }));
  const dPaseo = path.join(d, 'paseo-home');
  fs.mkdirSync(dPaseo, { recursive: true });
  fs.writeFileSync(path.join(dPaseo, 'config.json'), JSON.stringify({ daemon: { agentProfiles: [{ name: 'junior-a', provider: 'opencode', model: 'x' }] } }));
  const project = path.join(d, 'project');
  execFileSync('git', ['init', '-q', project]);
  execFileSync('git', ['-C', project, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base']);
  const leg = path.join(dPaseo, 'worktrees', 'abc', 'paseo-t-960');
  const calls = path.join(d, 'calls.jsonl');
  const fake = path.join(d, 'paseo');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === 'workspace' && args[1] === 'create') {
  fs.mkdirSync(require('node:path').dirname(${JSON.stringify(leg)}), { recursive: true });
  execFileSync('git', ['-C', opt('--path'), 'worktree', 'add', '-q', '-b', opt('--new-branch'), ${JSON.stringify(leg)}]);
  process.stdout.write(JSON.stringify({ workspaceId: 'wks_960', cwd: ${JSON.stringify(leg)} }));
} else if (args[0] === 'run') { process.stdout.write('agent-960\\n'); }
else if (args[1] === 'ls') { process.stdout.write('[]'); }
`, { mode: 0o755 });
  const dGrants = path.join(d, 'grants.json');
  const out = spawnSync('bash', [path.join(stewardRepo, 'tools', 'dispatch.sh'), 'T-960', '--role', 'junior-a', '--',
    '--new-workspace', 'worktree', '--worktree-mode', 'branch-off', '--new-branch', 'paseo/T-960', '--base', 'HEAD',
    '--cwd', project, '--title', 'T-960 leg', 'brief'], {
    encoding: 'utf8', env: { ...process.env, PASEO_BIN: fake, PASEO_HOME: dPaseo, PASEO_STEWARD_GRANTS: dGrants },
  });
  assert.equal(out.status, 0, `dispatch exit ${out.status}: ${out.stderr}`);
  const dGrant = JSON.parse(fs.readFileSync(dGrants, 'utf8')).grants.find((g) => g.task === 'T-960');
  assert.equal(dGrant.cwd, leg, 'the grant names the exact worktree the daemon created');
  assert.ok(dGrant.token, 'the grant carries a token');
  assert.equal(fs.readFileSync(path.join(leg, '.steward-grant'), 'utf8').trim(), dGrant.token, 'the same token is inside the worktree');
  const lock = JSON.parse(fs.readFileSync(path.join(stewardRepo, '.locks', 'T-960.json'), 'utf8'));
  assert.equal(lock.token, dGrant.token, 'the grant token is the reservation token');
  assert.deepEqual(lock.allowed_commands, ['npx tsc --noEmit', 'rm -rf*'], 'the declaration is snapshotted outside the worktree before launch');
  assert.equal(dGrant.locks, path.join(stewardRepo, '.locks'), 'the grant points at the dispatcher\'s snapshot');
  assert.deepEqual(server.declaredCommands(dGrant.locks, 'T-960', dGrant.token), ['npx tsc --noEmit'], 'the hook reads the snapshot back');
  const logged = fs.readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const created = logged.findIndex((a) => a[0] === 'workspace' && a[1] === 'create');
  const ran = logged.findIndex((a) => a[0] === 'run');
  assert.ok(created >= 0 && ran > created, 'the worktree exists before the agent is started');
  const runArgs = logged[ran];
  assert.equal(runArgs[runArgs.indexOf('--workspace') + 1], 'wks_960', 'the agent runs in the workspace the dispatcher created');
  for (const flag of ['--new-workspace', '--base', '--new-branch', '--cwd']) assert.ok(!runArgs.includes(flag), `${flag} is consumed by the dispatcher`);
  assert.equal(runArgs[runArgs.length - 1], 'brief', 'the prompt still comes last');
  assert.equal(JSON.parse(fs.readFileSync(path.join(stewardRepo, '.locks', 'T-960.json'), 'utf8')).agent, 'agent-960', 'V12-09: the attempt\'s agent is recorded beside the reservation');
  const status = execFileSync('git', ['-C', leg, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.ok(!status.includes('.steward-grant'), 'the token file never shows up as a change to commit');
}

// A corrupt registry never invents permission and never blocks creation.
fs.writeFileSync(grantsFile, '{not json');
assert.equal(handler({ request: juniorRequest }), juniorRequest, 'an unreadable registry changes nothing');
assert.deepEqual(server.readGrants(), []);

// A linked worktree keeps its git metadata in the main repository; a sandbox that allows only the worktree cannot
// commit, which the first codex worker discovered the hard way ("git metadata is read-only").
const extra = ['/home/example/.paseo/repo/.git/worktrees/paseo-t-900', '/home/example/.paseo/repo/.git'];
const withGit = shared.grantOptions('codex', 'implement', WT, HOME, extra);
assert.deepEqual(withGit.sandbox_workspace_write.writable_roots, [WT, ...extra], 'the leg may commit inside its own git metadata');
const claudeGit = shared.grantOptions('claude', 'implement', WT, HOME, extra);
assert.deepEqual(claudeGit.sandbox.filesystem.allowWrite, [WT, ...extra]);
// The git directories are discovered, never assumed: a path that is not a repository yields none.
assert.deepEqual(server.gitWritableRoots(tmp).filter((p) => p.includes('.git')), []);

// V12-01: the git metadata claim is text the worker can rewrite. Only `<repo>/.git/worktrees/<name>` is bound.
const gitFixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'leg47-git-')));
const fixtureHome = path.join(gitFixture, 'paseo-home');
const mainRepo = path.join(gitFixture, 'repo');
const linked = path.join(fixtureHome, 'worktrees', 'x', 'paseo-t-950');
fs.mkdirSync(path.dirname(linked), { recursive: true });
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', mainRepo]);
git(mainRepo, 'commit', '-q', '--allow-empty', '-m', 'base');
git(mainRepo, 'worktree', 'add', '-q', linked);
const linkedMeta = path.join(mainRepo, '.git', 'worktrees', 'paseo-t-950');
assert.deepEqual(server.gitWritableRoots(linked, fixtureHome), [linkedMeta, path.join(mainRepo, '.git')], 'a real linked worktree may commit');
// `gitdir: /` must bind nothing at all -- not the root, not anything else.
assert.deepEqual(server.gitMetadataRoots('/', linked, fixtureHome), [], 'the root is never git metadata');
const pointed = path.join(fixtureHome, 'worktrees', 'x', 'paseo-t-951');
fs.mkdirSync(pointed, { recursive: true });
fs.writeFileSync(path.join(pointed, '.git'), 'gitdir: /\n');
assert.deepEqual(server.gitWritableRoots(pointed, fixtureHome), [], 'a `gitdir: /` pointer grants nothing');
// A crafted git directory satisfies git itself (HEAD, objects, refs); the shape check still refuses it.
const crafted = path.join(gitFixture, 'crafted');
for (const dir of ['objects', 'refs']) fs.mkdirSync(path.join(crafted, dir), { recursive: true });
fs.writeFileSync(path.join(crafted, 'HEAD'), 'ref: refs/heads/main\n');
const craftedWt = path.join(fixtureHome, 'worktrees', 'x', 'paseo-t-952');
fs.mkdirSync(craftedWt, { recursive: true });
fs.writeFileSync(path.join(craftedWt, '.git'), `gitdir: ${crafted}\n`);
assert.deepEqual(server.gitWritableRoots(craftedWt, fixtureHome), [], 'a crafted git directory grants nothing');
assert.deepEqual(server.gitMetadataRoots('relative/.git/worktrees/x', linked, fixtureHome), [], 'a relative claim is refused');
// Metadata that contains the Paseo home would make every leg writable.
assert.deepEqual(server.gitMetadataRoots(linkedMeta, linked, path.join(mainRepo, '.git', 'worktrees')), [], 'an ancestor of the Paseo home is refused');

// OpenCode's containment is the tool layer, because Paseo runs one shared OpenCode server with a neutral cwd.
const opencodeNoDecl = shared.grantOptions('opencode', 'implement', WT, HOME);
assert.equal(opencodeNoDecl.permission.bash, 'ask', 'no declaration means every command is a question');
assert.equal(opencodeNoDecl.permission.external_directory, 'deny', 'a path outside the worktree is refused');

const declared = ['npx tsc --noEmit', './tools/suite.sh', 'git status'];
const opencodeDecl = shared.grantOptions('opencode', 'implement', WT, HOME, [], declared);
assert.equal(opencodeDecl.permission.bash['npx tsc --noEmit'], 'allow');
assert.equal(opencodeDecl.permission.bash['./tools/suite.sh'], 'allow');
assert.equal(opencodeDecl.permission.bash['*'], 'ask', 'a command the leg never declared still asks');

// V12-05: the declaration is read from the dispatcher's `.locks/<task>.json`, never from the leg's own manifest, and
// only when its token is the grant's. A pattern is still dropped rather than trusted.
// (Realigned: this fixture used to put the declaration in the worktree's checks/tasks/<task>.json.)
const locksDir = path.join(tmp, 'locks');
fs.mkdirSync(locksDir, { recursive: true });
fs.writeFileSync(path.join(locksDir, 'T-903.json'), JSON.stringify({ task: 'T-903', token: 'tok-903', allowed_commands: ['rg foo', 'rm -rf*', '  npx   tsc  '] }));
assert.deepEqual(server.declaredCommands(locksDir, 'T-903', 'tok-903'), ['rg foo', 'npx tsc'], 'normalised, and the pattern is refused');
assert.deepEqual(server.declaredCommands(locksDir, 'T-903', 'tok-other'), [], 'another dispatch\'s snapshot declares nothing');
assert.deepEqual(server.declaredCommands(locksDir, 'T-999', 'tok-903'), [], 'an unknown task declares nothing');
assert.deepEqual(server.declaredCommands(undefined, 'T-903', 'tok-903'), [], 'a grant without a locks directory declares nothing');
assert.deepEqual(server.declaredCommands(path.join(tmp, 'nope'), 'T-903', 'tok-903'), [], 'a missing snapshot declares nothing');

// The review's reproduction: a worker writes allowed_commands into its own worktree's manifest. The hook ignores it.
const legDir = path.join(tmp, 'worktrees', 'x', 'paseo-t-903');
fs.mkdirSync(path.join(legDir, 'checks', 'tasks'), { recursive: true });
fs.writeFileSync(path.join(legDir, 'checks', 'tasks', 'T-903.json'), JSON.stringify({ allowed_commands: ['touch /tmp/approval-from-worker-manifest'] }));
const legGrant = { task: 'T-903', role: 'implement', profile: 'junior-a', provider: 'opencode', cwd: legDir, at: new Date().toISOString(), token: 'tok-903' };
const fromWorker = server.applyGrant({ config: { provider: 'opencode/x', cwd: legDir } }, HOME, [legGrant]);
assert.equal(fromWorker.config.providerOptions.permission.bash, 'ask', 'a worker-written manifest approves nothing');
const fromDispatcher = server.applyGrant({ config: { provider: 'opencode/x', cwd: legDir } }, HOME, [{ ...legGrant, locks: locksDir }]);
assert.equal(fromDispatcher.config.providerOptions.permission.bash['rg foo'], 'allow', 'the dispatcher\'s snapshot does');
assert.equal(fromDispatcher.config.providerOptions.permission.bash['touch /tmp/approval-from-worker-manifest'], undefined, 'and only it');

// Inside bubblewrap the shell needs no answer, because it cannot reach anything the kernel has not bound.
const opencodeSbx = shared.grantOptions('opencode-sbx', 'implement', WT, HOME);
assert.equal(opencodeSbx.permission.bash, 'allow');
assert.equal(opencodeSbx.permission.external_directory, 'deny', 'the agent still stays inside its own workspace');

// Nested sandboxes do not work: the outer bubblewrap is the only one.
const sbxOptions = shared.grantOptions('claude-sbx', 'implement', WT, HOME);
assert.deepEqual(sbxOptions, { settings: { sandbox: { enabled: false } } }, 'claude-sbx must not ask Claude to sandbox again');

// A sandboxed provider override (claude-sbx) removes the prompts ourselves: the sandbox is under the tool layer.
const sbxGrant = { task: 'T-904', role: 'implement', profile: 'senior-opus', provider: 'claude-sbx', cwd: WT, at: new Date().toISOString() };
fs.writeFileSync(grantsFile, JSON.stringify({ grants: [sbxGrant] }));
const sbxApplied = handler({ request: { config: { provider: 'claude-sbx/claude-opus-5-5', cwd: WT } } });
assert.equal(sbxApplied.config.modeId, 'bypassPermissions', 'inside our own sandbox, no prompt is needed');
const explicitMode = handler({ request: { config: { provider: 'claude-sbx/x', cwd: WT, modeId: 'plan' } } });
assert.equal(explicitMode.config.modeId, 'plan', 'a mode the caller chose is not overridden');

// V12-06: the provider is compared by equality with the grant's. A request for another provider gets nothing at all.
// (Realigned: these two requests used to receive options for the claude-sbx grant, minus the mode.)
const plainClaudeReq = { config: { provider: 'claude/claude-opus-5-5', cwd: WT } };
assert.equal(handler({ request: plainClaudeReq }), plainClaudeReq, 'plain claude under a claude-sbx grant is untouched');
const opencodeSbxReq = { config: { provider: 'opencode-sbx/opencode/x', cwd: WT } };
assert.equal(handler({ request: opencodeSbxReq }), opencodeSbxReq, 'another provider under a claude-sbx grant is untouched');
// The review's reproduction: a provider whose name merely looks sandboxed.
const lookalike = { config: { provider: 'claude-sbx-plain', cwd: WT, modeId: 'default' } };
assert.equal(handler({ request: lookalike }), lookalike, 'claude-sbx-plain under a claude-sbx grant is untouched');
fs.writeFileSync(grantsFile, JSON.stringify({ grants: [{ ...sbxGrant, provider: 'claude-sbx-plain' }] }));
const lookalikeGranted = handler({ request: lookalike });
assert.equal(lookalikeGranted.config.modeId, 'default', 'only claude-sbx itself gets bypassPermissions');
assert.equal(lookalikeGranted.config.providerOptions.sandbox.enabled, true, 'a lookalike keeps the inner sandbox on');
assert.equal(shared.grantOptions('opencode-sbx-plain', 'implement', WT, HOME).permission.bash, 'ask', 'a lookalike opencode keeps asking');
assert.equal(shared.providerId('Claude-SBX/claude-opus-5-5'), 'claude-sbx');

console.log('PASS leg47: per-role provider options narrow only; the dispatcher record is the lookup key; no grant means no change');
