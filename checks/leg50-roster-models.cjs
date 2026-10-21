// On 2026-10-20 a leg was dispatched with a model id that did not exist and died silently. This check reads the daemon
// config (never the daemon) and fails loudly, naming the profile and field, when a profile cannot possibly resolve.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');

// `antigravity` is not in the brief's list but is a supported provider (CLAUDE.md) and review-gemini uses it.
const BUILTIN = ['claude', 'codex', 'copilot', 'opencode', 'pi', 'omp', 'antigravity'];

function validate(config) {
  const errors = [], notes = [];
  const profiles = config?.daemon?.agentProfiles;
  const overrides = config?.agents?.providers ?? {};
  if (!Array.isArray(profiles)) return { errors: ['daemon.agentProfiles: missing or not an array'], notes };
  const seen = new Set();
  for (const [i, p] of profiles.entries()) {
    const label = typeof p?.name === 'string' && p.name ? p.name : `#${i}`;
    for (const f of ['name', 'provider', 'model'])
      if (typeof p?.[f] !== 'string' || !p[f].trim()) errors.push(`profile ${label}: field "${f}" is missing or empty`);
    if (typeof p?.provider === 'string' && p.provider.trim()) {
      const known = BUILTIN.includes(p.provider) || Object.hasOwn(overrides, p.provider);
      if (!known) errors.push(`profile ${label}: field "provider" is "${p.provider}", not a builtin (${BUILTIN.join(' ')}) or a key of agents.providers`);
      if (Object.hasOwn(overrides, p.provider) && !seen.has(p.provider)) {
        seen.add(p.provider);
        const ext = overrides[p.provider]?.extends;
        notes.push(`provider override "${p.provider}" (used by ${label}): extends ${ext ?? '(none)'}`);
        // A builtin key overriding itself needs no `extends`; a custom key must name a builtin.
        if (ext === undefined ? !BUILTIN.includes(p.provider) : !BUILTIN.includes(ext))
          errors.push(`profile ${label}: provider override "${p.provider}" has extends ${ext === undefined ? "(none)" : `"${ext}"`}, not a builtin`);
      }
    }
  }
  return { errors, notes };
}

// --- Prove the check can fail -----------------------------------------------------------------------------------
const fx = fs.mkdtempSync(path.join(os.tmpdir(), 'leg50-'));
try {
  const base = { daemon: { agentProfiles: [{ name: 'ok', provider: 'claude', model: 'm' }] }, agents: { providers: {} } };
  const write = (name, cfg) => { const f = path.join(fx, name); fs.writeFileSync(f, JSON.stringify(cfg)); return JSON.parse(fs.readFileSync(f, 'utf8')); };
  assert.deepEqual(validate(write('good.json', base)).errors, [], 'fixture control must pass');
  const a = validate(write('a.json', { ...base, daemon: { agentProfiles: [{ name: 'bad-prov', provider: 'nope', model: 'm' }] } })).errors;
  assert.ok(a.some((e) => e.includes('bad-prov') && e.includes('"provider"')), `unknown provider not reported: ${a}`);
  const b = validate(write('b.json', { ...base, daemon: { agentProfiles: [{ name: 'bad-model', provider: 'codex', model: '' }] } })).errors;
  assert.ok(b.some((e) => e.includes('bad-model') && e.includes('"model"')), `empty model not reported: ${b}`);
  const c = validate(write('c.json', { ...base, agents: { providers: { x: { extends: 'ghost' } } }, daemon: { agentProfiles: [{ name: 'bad-ext', provider: 'x', model: 'm' }] } })).errors;
  assert.ok(c.some((e) => e.includes('bad-ext') && e.includes('extends')), `bad extends not reported: ${c}`);
} finally { fs.rmSync(fx, { recursive: true, force: true }); }
console.log('negative fixtures: unknown provider, empty model, bad extends all reported');

// --- The real config --------------------------------------------------------------------------------------------
const { skip, missingDaemonConfig } = require('./preconditions.cjs');
const file = path.join(process.env.PASEO_HOME || path.join(os.homedir(), '.paseo'), 'config.json');
const missingConfig = missingDaemonConfig(path.dirname(file));
if (missingConfig) skip(`${missingConfig}; the negative fixtures above still ran`);
const { errors, notes } = validate(JSON.parse(fs.readFileSync(file, 'utf8')));
for (const n of notes) console.log(n);
if (errors.length) { for (const e of errors) console.error(`FAIL ${e}`); process.exit(1); }
console.log('roster models ok');
