// LEG 14 acceptance: a designed deferral is not a failure.
// Red before the answer-pending fix: one deferred + one answered returned ok:false.
// `node checks/leg14-pending-ok.cjs`
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const configPath = '/leg14-fixture/config.json';
const project = '/leg14-fixture/project';
const agent = { id: 'agent-123', title: 'Fixture agent', cwd: project };
const config = {
  root: project, workspace: 'ws-1', provider: 'fixture', thinking: 'high', intervalMinutes: 20,
  enabled: false, leaseStaleMinutes: 15, autoAllowPlanExit: true, autoDenyQuestions: true,
  autoAllowShell: true,
};

async function bundle(entry) {
  return (await build({
    entryPoints: [path.join(root, entry)], bundle: true, platform: 'node', format: 'cjs',
    write: false, external: ['@getpaseo/*'],
  })).outputFiles[0].text;
}

function load(code, filename) {
  const m = new Module(filename);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(root);
  m._compile(code, filename);
  return m.exports;
}

/** A fake responder: `pending` rows drive both `paseo permit ls` and the SDK snapshot. */
function fixture(code, options = {}) {
  const files = new Map([
    [configPath, JSON.stringify({ projects: [config], audit: [], auditEvictions: {} })],
    [`${project}/control/COMMAND.md`, '# Fixture\n'],
  ]);
  let pending = (options.pending ?? []).map((r) => ({ ...r, agentId: agent.id }));
  const responses = [];
  const fs = {
    existsSync: (p) => files.has(String(p)) || p === project,
    readFileSync(p) { if (!files.has(String(p))) throw new Error('ENOENT'); return files.get(String(p)); },
    writeFileSync(p, text) { files.set(String(p), String(text)); },
    renameSync(from, to) { files.set(String(to), files.get(String(from))); files.delete(String(from)); },
    unlinkSync(p) { files.delete(String(p)); },
    openSync() { return 123; }, fsyncSync() {}, closeSync() {},
  };
  const cp = { execFile(_bin, args, _opts, callback) {
    let value = [];
    if (args[0] === 'workspace') value = [{ project: 'project', workspaceId: 'ws-1', cwd: project, isolation: 'local', name: 'Fixture' }];
    if (args[0] === 'agent') value = [{ id: agent.id, name: agent.title, cwd: project, status: 'idle' }];
    if (args[0] === 'permit') value = pending.map((r) => ({ ...r }));
    callback(null, JSON.stringify(value), '');
  }};
  const m = new Module(path.join(root, 'checks/leg14-fixture.cjs'));
  m.filename = path.join(root, 'checks/leg14-fixture.cjs');
  m.paths = Module._nodeModulePaths(root);
  const nativeRequire = m.require.bind(m);
  m.require = (id) => id === 'node:fs' ? fs : id === 'node:child_process' ? cp : nativeRequire(id);
  m._compile(`(function(process) {\n${code}\n})({env: {PASEO_STEWARD_CONFIG: ${JSON.stringify(configPath)}}});`, m.filename);
  const ref = {
    cwd: project,
    get pendingPermissions() { return pending; },
    async refresh() { return { agent: { pendingPermissions: [...pending] } }; },
    async respondToPermission({ requestId, response }) {
      if (options.respond) await options.respond({ requestId, response });
      responses.push({ requestId, response });
      pending = pending.filter((r) => r.id !== requestId);
    },
  };
  const context = { paseo: { agents: { ref: () => ref } } };
  return {
    api: m.exports, context,
    get responses() { return responses; },
    get pending() { return pending; },
    sweep() { return m.exports.controlSteward({ action: 'answer-pending', project }, context); },
  };
}

// A row WITH an authoritative input that still cannot be decided: the intent is a designed deferral, not a
// missing snapshot (review N1 made those two different outcomes).
const DEFERRED = { id: 'deferred', name: 'WriteFile', kind: 'tool', input: { content: 'x' } };
// The sweep now requires an authoritative snapshot: a kind and an input. A row without input is deferred.
const ANSWERED = { id: 'answered', name: 'ExitPlanMode', kind: 'plan', input: {} };

async function main() {
  const server = await bundle('server/steward.ts');
  const strings = load(await bundle('client/strings.ts'), path.join(root, 'checks/leg14-strings.cjs'));

  // 1. One deferred, one answered: nothing failed, so the sweep reports success and the UI refetches.
  const mixed = fixture(server, { pending: [ANSWERED, DEFERRED] });
  const mixedResult = await mixed.sweep();
  assert.equal(mixed.responses.length, 1, 'only the answerable request is sent');
  assert.equal(mixed.responses[0].requestId, ANSWERED.id);
  assert.equal(mixed.pending.length, 1, 'the deferred request stays pending');
  assert.equal(mixedResult.ok, true, 'a designed deferral must not make the aggregate false');
  assert.match(mixedResult.message, /left pending/, 'a deferred row must say what was deferred');
  // The fixture's deferred request is a WriteFile with no readable path, so the honest reason is the edit one:
  // a write we could not prove is inside the worker's worktree belongs to the human.
  assert.match(mixedResult.message, /a write outside the worker's own worktree; the human decides/,
    'the deferral reason stays honest');

  // 2. A real send failure is still a failure, even beside a deferral.
  const failed = fixture(server, {
    pending: [ANSWERED, DEFERRED],
    respond: ({ requestId }) => { if (requestId === ANSWERED.id) throw new Error('Transport disconnected'); },
  });
  const failedResult = await failed.sweep();
  assert.equal(failedResult.ok, false, 'a failed send must still report failure');
  assert.match(failedResult.message, /failed/, 'the failure is visible in the message');

  // 3. Every `left pending` sentence the server emits has a Chinese rule, including external/other.
  const sentences = [
    'left pending — project is not onboarded',
    'left pending — agent is in no steward project',
    'left pending — this policy is off',
    'left pending — an out-of-project path other than /tmp; the human decides',
    'left pending — not a plan exit, a question, a shell command or /tmp scratch; the human decides',
  ];
  for (const kind of ['plan', 'other', 'shell', 'external', 'temp']) {
    for (const sentence of sentences) {
      const raw = `abc1234 WriteFile (${kind}): ${sentence}`;
      const shown = strings.serverMessage(raw);
      assert.notEqual(shown, raw, `untranslated: ${raw}`);
      assert.match(shown, /仍待处理/, `missing deferral wording: ${raw}`);
    }
  }

  console.log('PASS  leg14: deferrals do not fail the sweep; failures do; deferral sentences are translated');
}

main().catch((e) => { console.error(`FAIL  leg14: ${e.message}`); process.exitCode = 1; });
