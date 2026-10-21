#!/usr/bin/env node
// F7: refuse disk-only acceptance helpers before running any gate command.
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const root = mkdtempSync('/tmp/leg28-');
const registry = mkdtempSync('/tmp/leg28-registry-');
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.email', 'test@example.invalid');
git('config', 'user.name', 'Test');
mkdirSync(join(root, 'checks/tasks'), { recursive: true });
mkdirSync(join(root, 'checks/out'), { recursive: true });
writeFileSync(join(root, 'check.sh'), '. ./helper.sh\n');
git('add', '.'); git('commit', '-qm', 'base');
const base = git('rev-parse', 'HEAD');
mkdirSync(join(registry, 'checks/tasks'), { recursive: true });
writeFileSync(join(registry, 'checks/tasks/T-28.json'), JSON.stringify({
  task_id: 'T-28', lane: 'standard', tier: 'junior', risk: 'R1', brief_kind: 'delivery', base,
  write_scope: ['helper.sh'], forbidden: [], ops_actions: [],
  acceptance: [{ kind: 'cmd', cmd: 'sh check.sh' }], expires_at: null, p0_or_p1: 'P0',
  cancel_how: 'retain evidence', reference: []
}));
writeFileSync(join(root, 'checks/tasks/record.json'), '{}\n');
writeFileSync(join(root, 'checks/out/evidence.json'), '{}\n');
writeFileSync(join(root, 'helper.sh'), 'exit 0\n');
function run(commit) {
  return spawnSync(process.execPath, [join(__dirname, 'guard.cjs'), 'check', '--task', 'T-28',
    '--base', base, '--commit', commit, '--worktree', root, '--registry', registry], { encoding: 'utf8' });
}
const dirty = run(base);
assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
assert.match(dirty.stderr, /untracked.*helper.sh/s);
const artifact = JSON.parse(readFileSync(join(root, `checks/out/guard-T-28-${base}.json`)));
assert.deepEqual(artifact.gate.commands, []);
console.log('PASS untracked helper refused by name; no gate commands executed');
git('add', 'helper.sh'); git('commit', '-qm', 'commit helper');
const clean = run(git('rev-parse', 'HEAD'));
assert.equal(clean.status, 0, clean.stdout + clean.stderr);
assert.match(clean.stdout, /GATE_PASS/);
console.log('PASS committed helper passes with untracked delegation records');
writeFileSync(join(root, 'checks/tasks-extra.js'), 'exit 0\n');
const sibling = run(git('rev-parse', 'HEAD'));
assert.equal(sibling.status, 1, sibling.stdout + sibling.stderr);
assert.match(sibling.stderr, /checks\/tasks-extra.js/);
console.log('PASS similarly named source outside record directories is refused');

// F8: read the standalone server with a persisted notice in both modes.
(async () => {
  const bundle = join(registry, 'server.cjs');
  execFileSync('npx', ['esbuild', 'server/steward.ts', '--bundle', '--platform=node', '--format=cjs',
    '--outfile=' + bundle, '--external:@getpaseo/*'], { cwd: join(__dirname, '..'), stdio: 'ignore' });
  process.env.NODE_PATH = join(__dirname, '../node_modules');
  require('node:module').Module._initPaths();
  const config = join(registry, 'config.json');
  const fake = join(registry, 'paseo');
  writeFileSync(fake, '#!/bin/sh\nprintf "[]\\n"\n', { mode: 0o755 });
  process.env.PASEO_BIN = fake;
  process.env.PASEO_STEWARD_CONFIG = config;
  const server = require(bundle);
  for (const on of [false, true]) {
    writeFileSync(config, JSON.stringify({ projects: [{ root, enabled: on, lazyMode: on,
      pendingWakes: [{ id: 'notice', line: 'done', at: '2026-10-20T01:00:00Z' }] }] }));
    const state = await server.readSteward({ project: root });
    const warning = state.warnings.find(w => w.startsWith('pending completion delivery:'));
    assert.ok(warning);
    if (on) assert.match(warning, /The wheel will retry/);
    else { assert.match(warning, /waiting for a human/); assert.doesNotMatch(warning, /retry|successor/i); }
    console.log(`PASS lazy ${on ? 'on retains retry' : 'off waits for human'} warning`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
