// Run current code: node checks/leg5-permissions.cjs
// Negative control: node checks/leg5-permissions.cjs --ref 10ce90b --finding F1
// Bundles either revision in memory. Files, CLI results, and SDK snapshots are isolated.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { build } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const revision = process.argv.includes('--ref') ? process.argv[process.argv.indexOf('--ref') + 1] : null;
const finding = process.argv.includes('--finding') ? process.argv[process.argv.indexOf('--finding') + 1] : null;
const configPath = '/leg5-fixture/config.json';
const project = '/leg5-fixture/project';
const agent = { id: 'agent-123', title: 'Fixture agent', cwd: project };
const config = {
  root: project, workspace: 'ws-1', provider: 'fixture', thinking: 'high', intervalMinutes: 20,
  enabled: false, leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true,
};

async function bundle() {
  const plugins = revision ? [{
    name: 'historical-source',
    setup(b) {
      b.onLoad({ filter: /\/(server|shared)\/steward\.ts$/ }, ({ path: filename }) => ({
        contents: execFileSync('git', ['show', `${revision}:${path.relative(root, filename)}`], { cwd: root, encoding: 'utf8' }),
        loader: 'ts', resolveDir: path.dirname(filename),
      }));
    },
  }] : [];
  return (await build({ entryPoints: [path.join(root, 'server/steward.ts')], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['@getpaseo/*'], plugins })).outputFiles[0].text;
}

function fixture(code, options = {}) {
  const files = options.files ?? new Map([[configPath, JSON.stringify({ projects: [config], audit: [] })]]);
  if (options.onboarded !== false) files.set(`${project}/control/COMMAND.md`, '# Fixture\n');
  const logs = [];
  let writes = 0;
  let attempts = 0;
  let responses = [];
  let pending = [];
  let failWrites = options.failWrites ?? false;
  const fail = () => failWrites === true || (typeof failWrites === 'number' && writes >= failWrites);
  const fs = {
    existsSync: (p) => files.has(String(p)) || p === project,
    readFileSync(p) { if (!files.has(String(p))) throw new Error('ENOENT'); return files.get(String(p)); },
    writeFileSync(p, text) { writes++; if (fail()) throw new Error('EACCES: fixture config write denied'); files.set(String(p), String(text)); },
    renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
    unlinkSync(p) { files.delete(String(p)); },
    openSync() { return 123; }, fsyncSync() {}, closeSync() {},
  };
  const cp = { execFile(_bin, args, _opts, callback) {
    let value = [];
    if (args[0] === 'workspace') value = [{ project: 'project', workspaceId: 'ws-1', cwd: project, isolation: 'local', name: 'Fixture' }];
    if (args[0] === 'agent') value = [{ id: agent.id, name: agent.title, cwd: project, status: 'idle' }];
    if (args[0] === 'permit') value = pending.map(r => ({ ...r, agentId: agent.id }));
    callback(null, JSON.stringify(value), '');
  }};
  const m = new Module(path.join(root, 'checks/fixture.cjs'));
  m.filename = path.join(root, 'checks/fixture.cjs');
  m.paths = Module._nodeModulePaths(root);
  const nativeRequire = m.require.bind(m);
  m.require = (id) => id === 'node:fs' ? fs : id === 'node:child_process' ? cp : nativeRequire(id);
  // Each isolated bundle closes over its own environment and console, without replacing globals.
  m._compile(`(function(process, console) {\n${code}\n})({env: {PASEO_STEWARD_CONFIG: ${JSON.stringify(configPath)}}}, {log: (...v) => module.logs.push(v.join(' ')), error: (...v) => module.logs.push(v.join(' '))});`, m.filename);
  // Console methods are only used after initialization.
  m.logs = logs;
  const ref = {
    cwd: project,
    get pendingPermissions() { return pending; },
    async refresh() { if (options.refreshFails) throw new Error('offline'); return { agent: { pendingPermissions: [...pending] } }; },
    async respondToPermission({ response }) {
      attempts++;
      if (options.respond) await options.respond(response);
      if (!options.suppressed) {
        responses.push(response);
        if (options.confirm !== false) pending = [];
      }
    },
  };
  const context = { paseo: { agents: { ref: () => ref } } };
  return {
    api: m.exports, files, logs, context,
    get attempts() { return attempts; }, get responses() { return responses; },
    get pending() { return pending; },
    failWrites(value) { failWrites = value; },
    persisted() { return JSON.parse(files.get(configPath)); },
    async request(request) { pending = [request]; await m.exports.onPermissionRequested({ agent, request }, context); },
    read() { return m.exports.readSteward({ project }); },
    sweep() { return m.exports.controlSteward({ action: 'answer-pending', project }, context); },
  };
}

const tests = {
  async F1(code) {
    const f = fixture(code);
    // Mandatory adversarial control: SDK tool kind with a plan-exit name stays PENDING.
    await f.request({ id: 'tool', name: 'ExitPlanMode', kind: 'tool' });
    assert.equal(f.responses.length, 0, 'F1: a tool permission was auto-allowed');
    assert.equal(f.pending[0]?.id, 'tool', 'F1: tool must stay PENDING');
    assert.equal(f.persisted().audit.length, 0);
    await f.request({ id: 'question', name: 'ExitPlanMode', kind: 'question', input: {} });
    assert.equal(f.responses.at(-1)?.behavior, 'deny', 'F1: SDK question kind must win');
    await f.request({ id: 'mismatch', name: 'Bash', kind: 'plan', input: {} });
    assert.equal(f.responses.length, 1, 'F1: plan kind alone is insufficient');
    await f.request({ id: 'unknown', name: 'ExitPlanMode' });
    assert.equal(f.responses.length, 1, 'F1: absent SDK kind must not authorize');
    await f.request({ id: 'plan', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(f.responses.at(-1)?.behavior, 'allow', 'F1: real plan exit is allowed');
  },
  async F2(code) {
    const f = fixture(code, { failWrites: true });
    await f.request({ id: 'no-save', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(f.responses.length, 0, 'F2: must persist intent before sending');
    assert.equal(f.persisted().audit.length, 0);
    const state = await f.read();
    assert.match(state.permissions.auditError, /EACCES/, 'F2: save failure must be visible');
    assert.equal(state.permissions.audit[0].recorded, false);
    assert.equal(state.permissions.audit[0].ok, false);
    f.failWrites(false);
    await f.request({ id: 'no-save', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(f.responses.length, 1, 'F2: failed preflight is retryable');
    assert.equal(f.persisted().audit[0].recorded, true);
    assert.equal((await f.read()).permissions.auditError, null);

    const late = fixture(code, { failWrites: 2 });
    await late.request({ id: 'late-save', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(late.responses.length, 1);
    const visible = await late.read();
    assert.equal(visible.permissions.audit[0].recorded, false, 'F2: final save must not claim recorded');
    assert.equal(visible.permissions.audit[0].ok, false);
    assert.match(visible.permissions.auditError, /EACCES/);
    assert.equal(late.persisted().audit[0].delivery, 'prepared', 'F2: durable intent must survive final-save failure');
    const restarted = fixture(code, { files: late.files });
    assert.equal((await restarted.read()).permissions.audit[0].delivery, 'prepared');
    late.failWrites(false);
    const recovered = await late.read();
    assert.equal(recovered.permissions.audit[0].recorded, true, 'F2: real memory store must recover');
    assert.equal(recovered.permissions.audit[0].delivery, 'confirmed');
  },
  async F3(code) {
    // Exercise the installed SDK's actual suppressSendErrors path without a transport.
    const { DaemonClient } = await import('@getpaseo/client/internal/daemon-client');
    const sdk = new DaemonClient({ url: 'ws://unused.invalid', clientId: 'leg5', suppressSendErrors: true,
      reconnect: { enabled: false } });
    const f = fixture(code, { suppressed: true, respond: (response) => sdk.respondToPermission(agent.id, 'suppressed', response) });
    await f.request({ id: 'suppressed', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(f.responses.length, 0, 'F3: disconnected SDK sends nothing');
    assert.equal(f.persisted().audit[0].ok, false, 'F3: suppressed send cannot be answered');
    assert.equal(f.persisted().audit[0].delivery, 'unconfirmed');
    assert.equal(f.pending.length, 1);
    const result = await f.sweep();
    assert.equal(f.attempts, 2, 'F3: unconfirmed request must remain retryable');
    assert.equal(f.persisted().audit.length, 2, 'F3: retry must retain the earlier attempt');
    assert.equal(result.ok, false, 'F3: sweep must not report confirmation');

    const sent = fixture(code, { confirm: false });
    await sent.request({ id: 'sent', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(sent.responses.length, 1);
    assert.equal(sent.persisted().audit[0].delivery, 'unconfirmed');
    assert.equal(sent.persisted().audit[0].ok, false);
    const confirmed = fixture(code);
    await confirmed.request({ id: 'confirmed', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(confirmed.persisted().audit[0].delivery, 'confirmed');
    assert.equal(confirmed.persisted().audit[0].ok, true);
    const unreadable = fixture(code, { refreshFails: true });
    await unreadable.request({ id: 'offline', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(unreadable.persisted().audit[0].delivery, 'unconfirmed');
    const failed = fixture(code, { respond: () => { throw new Error('Transport disconnected'); } });
    await failed.request({ id: 'send-failed', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(failed.persisted().audit[0].delivery, 'failed');
    assert.equal(failed.persisted().audit[0].ok, false);
  },
  async F4(code) {
    const f = fixture(code, { onboarded: false });
    assert.equal((await f.read()).onboarded, false);
    await f.request({ id: 'not-onboarded', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(f.responses.length, 0, 'F4: hidden non-onboarded project must not auto-answer');
    assert.equal(f.pending.length, 1);
    assert.equal(f.persisted().audit.length, 0);
    await f.sweep();
    assert.equal(f.responses.length, 0, 'F4: sweep must use the same onboarding gate');
  },
  async F8(code) {
    const f = fixture(code);
    for (let i = 0; i < 51; i++) await f.request({ id: `retained-${i}`, name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal((await f.read()).permissions.audit.length, 51, 'F8: no hidden 50-row cutoff');
    for (let i = 51; i < 201; i++) await f.request({ id: `retained-${i}`, name: 'ExitPlanMode', kind: 'plan', input: {} });
    const state = await f.read();
    assert.equal(state.permissions.audit.length, 200);
    assert.equal(f.persisted().audit.length, 200);
    assert.equal(state.permissions.auditRetention.projectCap, 200);
    assert.equal(state.permissions.auditRetention.totalCap, 200);
    assert.equal(state.permissions.auditRetention.retained, 200);
    assert.equal(state.permissions.auditRetention.evicted, 1);
    assert.ok(state.permissions.auditRetention.lastEvictedAt);
    assert.ok(!state.permissions.audit.some(a => a.requestId === 'retained-0'));
    const restarted = fixture(code, { files: f.files });
    assert.equal((await restarted.read()).permissions.auditRetention.evicted, 1, 'F8: eviction is durable');
    const mixed = fixture(code);
    const saved = f.persisted();
    saved.audit = saved.audit.map(a => ({ ...a, project: '/leg5-fixture/another-project' }));
    saved.auditEvictions = {};
    mixed.files.set(configPath, JSON.stringify(saved));
    await mixed.request({ id: 'mixed-project', name: 'ExitPlanMode', kind: 'plan', input: {} });
    assert.equal(mixed.persisted().audit.length, 200, 'F8: cap is shared across projects');
    assert.equal((await mixed.read()).permissions.audit.length, 1);
    assert.equal((await mixed.read()).permissions.auditRetention.evicted, 0);
    assert.equal(mixed.persisted().auditEvictions['/leg5-fixture/another-project'].count, 1,
      'F8: eviction is charged to the project whose row was removed');
  },
  async Boundaries(code) {
    const off = fixture(code);
    const stored = off.persisted();
    stored.projects[0].autoAllowPlanExit = false;
    stored.projects[0].autoDenyQuestions = false;
    off.files.set(configPath, JSON.stringify(stored));
    await off.request({ id: 'off-plan', name: 'ExitPlanMode', kind: 'plan', input: {} });
    await off.request({ id: 'off-question', name: 'AskUserQuestion', kind: 'question', input: {} });
    assert.equal(off.attempts, 0, 'disabled policies leave both requests pending');
    const race = fixture(code);
    await Promise.all([
      race.request({ id: 'racing', name: 'ExitPlanMode', kind: 'plan', input: {} }),
      race.request({ id: 'racing', name: 'ExitPlanMode', kind: 'plan', input: {} }),
    ]);
    assert.equal(race.attempts, 1, 'concurrent duplicate requests send once');
    const stale = fixture(code, { refreshFails: true });
    await stale.request({ id: 'stale-kind', name: 'ExitPlanMode', kind: 'tool', input: {} });
    await stale.sweep();
    assert.equal(stale.attempts, 0, 'CLI name or cached kind cannot replace fresh SDK kind');
    const corrupt = fixture(code);
    corrupt.files.set(configPath, '{invalid');
    await assert.rejects(corrupt.request({ id: 'corrupt', name: 'ExitPlanMode', kind: 'plan', input: {} }));
    assert.equal(corrupt.attempts, 0, 'corrupt config fails closed');
    assert.equal(corrupt.files.get(configPath), '{invalid', 'corrupt config is preserved');
    const legacy = fixture(code);
    const old = legacy.persisted();
    old.audit = [{ at: '2026-10-19T00:00:00Z', project, agentId: agent.id, requestId: 'legacy',
      request: 'ExitPlanMode', agentTitle: agent.title, kind: 'plan', decision: 'allow', source: 'event', ok: true, error: null }];
    legacy.files.set(configPath, JSON.stringify(old));
    const read = await legacy.read();
    assert.equal(read.permissions.audit[0].delivery, 'legacy');
    assert.equal(read.permissions.audit[0].ok, false, 'old send success is not proof of resolution');
  },
};

module.exports = { bundle, fixture, project };
if (require.main === module) (async () => {
  const code = await bundle();
  if (finding && !tests[finding]) throw new Error(`Unknown finding ${finding}`);
  let failed = 0;
  for (const [id, test] of Object.entries(tests)) {
    if (finding && id !== finding) continue;
    try { await test(code); console.log(`${id} PASS (${revision ?? 'working tree'})`); }
    catch (e) { failed++; console.error(`${id} FAIL (${revision ?? 'working tree'}): ${e.message}`); }
  }
  process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exitCode = 1; });
