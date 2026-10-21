#!/usr/bin/env node
// Six review findings, exercised through the public server API and an isolated fake CLI.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { join, basename } = require('node:path');
const { buildSync } = require('esbuild');
const REPO = join(__dirname, '..');
const TMP = fs.mkdtempSync('/tmp/steward-leg18-');
const SERVER = join(TMP, 'server.cjs');
const MODEL = join(TMP, 'model.cjs');
const STEWARD = 'aaaa1111-0000-4000-8000-000000000001';
const WORKER = 'bbbb2222-0000-4000-8000-000000000002';
for (const [entry, outfile] of [['server/steward.ts', SERVER], ['client/model.ts', MODEL]]) {
  buildSync({ entryPoints: [join(REPO, entry)], outfile, bundle: true, platform: 'node', format: 'cjs', external: ['@getpaseo/*'] });
}
process.env.NODE_PATH = join(REPO, 'node_modules');
require('node:module')._initPaths();
const cfgPath = join(TMP, 'config.json');
const fixturePath = join(TMP, 'cli.json');
const logPath = join(TMP, 'cli.log');
const fake = join(TMP, 'paseo');
fs.writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), f = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, 'utf8'));
fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + '\\n');
if (args[0] === 'agent' && args[1] === 'ls') { if(f.listError) process.exit(1); console.log(JSON.stringify(f.agents)); }
else if (args[0] === 'workspace') console.log(JSON.stringify(f.workspaces));
else if (args[0] === 'permit') console.log(JSON.stringify(f.permits));
else if (args[0] === 'agent' && args[1] === 'send') { if(f.sendError) process.exit(1); }
else if (args[0] === 'run') console.log('{"id":"new-agent"}');
else process.exit(1);
`);
fs.chmodSync(fake, 0o755);
process.env.PASEO_STEWARD_CONFIG = cfgPath;
process.env.PASEO_BIN = fake;
let fixture;
function cli(patch = {}) { Object.assign(fixture, patch); fs.writeFileSync(fixturePath, JSON.stringify(fixture)); }
function fresh() { delete require.cache[SERVER]; return require(SERVER); }
function config() { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')).projects[0]; }
function patchConfig(patch) { const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); Object.assign(c.projects[0], patch); fs.writeFileSync(cfgPath, JSON.stringify(c)); }
function calls(kind, sub) { return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(a => a[0] === kind && (!sub || a[1] === sub)); }
function command(root, claim = STEWARD) {
  fs.writeFileSync(join(root, 'control/COMMAND.md'), `# COMMAND\n\n## Lease\n\n    session=test\n    paseo-agent=${claim}\n    heartbeat=2020-01-01T00:00Z\n    state=held\n\n## Ready queue\n\n| task | goal |\n|---|---|\n\n## Dispatch ledger\n`);
}
function setup(name, claim = STEWARD) {
  const root = join(TMP, name);
  fs.mkdirSync(join(root, 'control'), { recursive: true }); command(root, claim);
  fs.writeFileSync(cfgPath, JSON.stringify({ // v1.0 ships with automatic shell approval OFF; this fixture exercises the OPT-IN path deliberately.
    projects: [{ root, workspace: 'main', enabled: true, lazyMode: true, maxConcurrent: 2, autoAllowShell: true }], audit: [], auditEvictions: {} }));
  fixture = { agents: [{ id: STEWARD, name: 'steward', cwd: root, status: 'running' }, { id: WORKER, name: 'worker', cwd: root, status: 'idle' }], workspaces: [{ project: basename(root), workspaceId: 'main', cwd: root, isolation: 'local', name: 'main' }, ...[1, 2].map(n => ({ project: basename(root), workspaceId: `w${n}`, cwd: `${root}-w${n}`, isolation: 'worktree', name: `w${n}` }))], permits: [] };
  cli(); fs.writeFileSync(logPath, ''); return root;
}
function event(root) { return { agent: { id: WORKER, title: 'final worker', cwd: root }, outcome: { kind: 'completed' } }; }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = setup('wake');
  let sdkSends = 0;
  fresh().onTurnEnded(event(root), { paseo: { agents: { ref: () => ({ send: async () => { sdkSends++; throw new Error('transport failed'); } }) } } });
  await delay(1800);
  assert.equal(sdkSends, 1);
  assert.equal(config().pendingWakes.length, 1);
  assert.equal(config().pokeFailureCount, 1);
  let state = await fresh().readSteward({ project: root });
  assert(state.warnings.some(w => /pending completion delivery/.test(w)));
  assert.equal(require(MODEL).stewardStatus(state).tone, 'warning');
  cli({ sendError: true });
  await fresh().wheelPass('interval');
  assert.equal(config().pokeFailureCount, 2);
  assert.equal(config().pendingWakes.length, 1);
  cli({ sendError: false });
  await fresh().wheelPass('interval');
  assert.equal(config().pendingWakes.length, 0);
  assert.equal(config().pokeFailureCount, 0);
  state = await fresh().readSteward({ project: root });
  assert(!state.warnings.some(w => /pending completion delivery/.test(w)));
  assert.equal(require(MODEL).stewardStatus(state).tone, 'success');
  // Exit before the coalescing timer fires, then recover in a fresh process/module.
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(SERVER)}).onTurnEnded(${JSON.stringify(event(root))}, {paseo:{}}); setTimeout(()=>process.exit(0),250);`], { env: process.env });
  assert.equal(config().pendingWakes.length, 1);
  await fresh().wheelPass('interval');
  assert.equal(config().pendingWakes.length, 0);
  assert.equal(calls('run').length, 0);
  console.log('PASS F3: failed delivery and interrupted buffer survive reload; empty Ready queue retries; warning clears only after delivery');
  const manualRoot = setup('manual');
  let m = fresh();
  await m.wheelPass('interval');
  await m.controlSteward({ action: 'tick-now', project: manualRoot });
  assert.equal(calls('run').length, 0);
  assert.equal(require(MODEL).canTakeOver(await m.readSteward({ project: manualRoot })), false);
  cli({ listError: true });
  m = fresh();
  await m.wheelPass('interval');
  const unknown = await m.controlSteward({ action: 'tick-now', project: manualRoot });
  assert.match(unknown.message, /UNKNOWN/);
  assert.equal(calls('run').length, 0);
  assert.equal(require(MODEL).canTakeOver(await m.readSteward({ project: manualRoot })), false);
  cli({ listError: false, agents: [] });
  patchConfig({ lastDispatchAt: new Date().toISOString() });
  await fresh().wheelPass('interval');
  assert.equal(calls('run').length, 0);
  await fresh().controlSteward({ action: 'tick-now', project: manualRoot });
  assert.equal(calls('run').length, 1);
  const noClaim = setup('no-claim', '(none)');
  patchConfig({ lastDispatchAt: new Date().toISOString(), lazyMode: false });
  await fresh().controlSteward({ action: 'tick-now', project: noClaim });
  assert.equal(calls('run').length, 1);
  console.log('PASS F4: automatic/manual gates protect live and unknown claims; manual overrides only timing');
  const lockRoot = setup('locked', '(none)');
  const lockPath = `${cfgPath}.dispatch.lock`;
  const lockBody = JSON.stringify({ pid: 2147483647, at: '2020-01-01T00:00Z' });
  fs.writeFileSync(lockPath, lockBody);
  const old = new Date(Date.now() - 60 * 60000);
  fs.utimesSync(lockPath, old, old);
  let lockState = await fresh().readSteward({ project: lockRoot });
  assert.equal(lockState.dispatchLock.path, lockPath);
  assert.match(lockState.dispatchLock.holder, /2147483647/);
  assert(lockState.dispatchLock.ageMinutes >= 60);
  assert(lockState.warnings.some(w => w.includes(lockPath) && /ALL projects/.test(w) && /Stop all dispatchers/.test(w)));
  assert((await fresh().wheelPass('interval')).some(w => w.includes(lockPath)));
  assert.match((await fresh().controlSteward({ action: 'tick-now', project: lockRoot })).message, /dispatch reservation/);
  assert.equal(calls('run').length, 0);
  assert.equal(fs.readFileSync(lockPath, 'utf8'), lockBody);
  fs.writeFileSync(lockPath, 'malformed');
  lockState = await fresh().readSteward({ project: lockRoot });
  assert.match(lockState.dispatchLock.holder, /unknown/);
  fs.unlinkSync(lockPath); // Test teardown only; production never removes an orphan.
  lockState = await fresh().readSteward({ project: lockRoot });
  assert.equal(lockState.dispatchLock, null);
  assert(!lockState.warnings.some(w => /dispatch reservation:/.test(w)));
  console.log('PASS F10: global reservation exposes path, holder, age and safe recovery; old/malformed locks stay closed');
  const batchRoot = setup('batch');
  const waves = join(batchRoot, 'control/WAVES.md');
  const historical = '## Batch 1 — ACTIVE\nBatch 1 is therefore: `11`, `12`\nBatch 1 completed.\n';
  fs.writeFileSync(waves, historical + '\n## Batch 2 — ACTIVE\nBatch 2 is therefore: `21`, `22`, W10\n');
  assert.deepEqual((await fresh().readSteward({ project: batchRoot })).batch, ['21', '22', 'W10']);
  fs.writeFileSync(waves, historical + '\nBatch 2 is therefore: `21`, `22`\n');
  assert.deepEqual((await fresh().readSteward({ project: batchRoot })).batch, []);
  fs.writeFileSync(waves, historical + '\n## Batch 2\nStatus: ACTIVE\nBatch 2 is therefore: leg 21, leg 22\n');
  assert.deepEqual((await fresh().readSteward({ project: batchRoot })).batch, ['21', '22']);
  fs.appendFileSync(waves, '\nStatus: completed\n');
  assert.deepEqual((await fresh().readSteward({ project: batchRoot })).batch, []);
  fs.writeFileSync(waves, 'Batch 1 ACTIVE is therefore: `11`\nBatch 2 ACTIVE is therefore: `21`\n');
  assert.deepEqual((await fresh().readSteward({ project: batchRoot })).batch, []);
  fs.unlinkSync(waves);
  assert.deepEqual((await fresh().readSteward({ project: batchRoot })).batch, []);
  console.log('PASS F11: only a single explicit ACTIVE batch is current; completed, missing and ambiguous batches return none');
  const permitRoot = setup('permits');
  async function policyPath(request, sweep, expected, sdkDescription = true) {
    let pending = [request];
    const responses = [];
    cli({ permits: [{ ...request, agentId: WORKER }] });
    const context = { paseo: { agents: { ref: () => ({
      cwd: permitRoot,
      // The sweep now demands an authoritative kind and input before it decides (review N1), so the snapshot
      // must look like the real SDK's rows rather than a name-only row.
      refresh: async () => ({ agent: { pendingPermissions: pending.map(r => ({
        ...r, kind: r.kind ?? 'tool', input: r.input ?? {},
        description: sdkDescription ? r.description : undefined,
      })) } }),
      respondToPermission: async ({ requestId, response }) => { responses.push(response.behavior); pending = pending.filter(r => r.id !== requestId); },
      send: async () => {},
    }) } } };
    const api = fresh();
    if (sweep) await api.controlSteward({ action: 'answer-pending', project: permitRoot }, context);
    else await api.onPermissionRequested({ agent: { id: WORKER, title: 'worker', cwd: permitRoot }, request }, context);
    assert.deepEqual(responses, expected);
  }
  for (const [id, name, description, input, expected] of [
    ['temp', 'external_directory', 'Scope: /tmp/*', { patterns: ['/tmp/*'], directories: ['/tmp'] }, ['allow']],
    // The source tree is a deployment detail: without PASEO_SOURCE_ROOT this path is external, and the test says so.
    ...(process.env.PASEO_SOURCE_ROOT ? [['source', 'external_directory', `Scope: ${process.env.PASEO_SOURCE_ROOT}/packages/cli/*`, { patterns: [`${process.env.PASEO_SOURCE_ROOT}/packages/cli/*`], directories: [`${process.env.PASEO_SOURCE_ROOT}/packages/cli`] }, ['allow']]] : []),
    ['mixed', 'external_directory', 'Scope: /tmp/*, /home/private/*', { patterns: ['/tmp/*', '/home/private/*'], directories: ['/tmp', '/home/private'] }, []],
    ['input-mixed', 'external_directory', 'Scope: /tmp/*', { path: '/home/private/x' }, []],
    ['blocked-input', 'CodexBash', '', { command: 'google-chrome https://example.com' }, ['deny']],
  ]) {
    const request = { id, name, kind: 'tool', description, input };
    await policyPath(request, false, expected);
    await policyPath(request, true, expected);
  }
  await policyPath({ id: 'fallback', name: 'external_directory', kind: 'tool', description: 'Scope: /tmp/*', input: { patterns: ['/tmp/*'], directories: ['/tmp'] } }, true, ['allow'], false);
  console.log('PASS F12: event and sweep preserve structured input for scratch, source, mixed scopes and blocked commands; an absent SDK description leaves the input authoritative');
  for (const claim of [STEWARD.slice(0, 7), STEWARD.slice(0, 8), `${STEWARD} (scheduled steward tick)`]) {
    const shortRoot = setup(`short-${claim.slice(0, 8)}`, claim);
    const sends = [];
    const shortApi = fresh();
    const shortState = await shortApi.readSteward({ project: shortRoot });
    assert.equal(shortState.lease.claimed, true);
    assert.equal(shortState.lease.agentPresent, true);
    shortApi.onTurnEnded(event(shortRoot), { paseo: { agents: { ref: id => ({ send: async () => { sends.push(id); } }) } } });
    await delay(1800);
    assert.deepEqual(sends, [STEWARD]);
    assert.equal(config().pendingWakes.length, 0);
    shortApi.onTurnEnded({ ...event(shortRoot), agent: { id: STEWARD, title: 'the steward', cwd: shortRoot } }, { paseo: {} });
    await delay(100);
    assert.equal(config().pendingWakes.length, 0);
    assert.equal(calls('run').length, 0);
  }
  const shortRetry = setup('short-retry', STEWARD.slice(0, 7));
  fresh().onTurnEnded(event(shortRetry), { paseo: { agents: { ref: () => ({ send: async () => { throw new Error('short delivery failed'); } }) } } });
  await delay(1800);
  assert.equal(config().pokeFailureAgent, STEWARD.slice(0, 7));
  assert.equal(config().pokeFailureCount, 1);
  cli({ listError: true });
  await fresh().wheelPass('interval');
  assert.equal(config().pendingWakes.length, 1);
  cli({ listError: false });
  await fresh().wheelPass('interval');
  assert.equal(calls('agent', 'send').at(-1)[2], STEWARD);
  assert.equal(config().pendingWakes.length, 0);
  console.log('PASS F13: seven/eight-character and labelled claims route to the full session id; self wakes excluded; short-id failure/reload recovers');
  console.log('OK leg18 recovery');
  console.log(`artifact_path=${TMP}`);
}
main().catch(error => { console.error(error); console.error(`log_path=${TMP}`); process.exitCode = 1; });
