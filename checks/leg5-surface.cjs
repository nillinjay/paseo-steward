// Render the real screen with fixture hooks and React Native host primitives.
// This checks content and theme/compact props; it is not a device screenshot test.
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const Module = require('node:module');
const path = require('node:path');
const { bundle, fixture, project } = require('./leg5-permissions.cjs');
const root = path.resolve(__dirname, '..');

async function screenModule(state) {
  const code = (await build({
    stdin: { contents: 'export { StewardScreen } from "./client/steward"; export { S, serverMessage } from "./client/strings";', resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false,
    // `@tanstack/react-query` must stay external too, or the real QueryClient requirement leaks into a
    // render fixture that stubs the query layer (T-118, 2026-10-20).
    external: ['react', 'react/jsx-runtime', 'react-native', '@getpaseo/*', '@tanstack/react-query'],
    plugins: [{ name: 'fixture-hooks', setup(b) {
      b.onResolve({ filter: /^\.\/data$/ }, () => ({ path: '__fixture_hooks__', external: true }));
    } }],
  })).outputFiles[0].text;
  const m = new Module(path.join(root, 'checks/surface-fixture.cjs'));
  m.filename = m.id;
  m.paths = Module._nodeModulePaths(root);
  const nativeRequire = m.require.bind(m);
  const hooks = {
    useProjects: () => ({ data: { projects: [{ root: project, name: 'Fixture', onboarded: state.onboarded }] } }),
    useSteward: () => ({ data: state, isLoading: false, refetch() {} }),
    useStewards: roots => roots.map(() => ({ data: state })),
    useStewardControl: () => async () => ({ ok: true, message: '' }),
    // The screen builds query keys from this export; the fixture must present the same shape.
    STEWARD_KEY: ['steward'],
  };
  // The screen now reads an RPC through useQuery. Stub both so the fixture stays a render test rather than a
  // framework test: no query, no bar, and the assertions below still describe the real screen.
  const reactStub = {
    useState: initial => [initial, () => {}], useEffect() {}, useMemo: fn => fn(),
    useCallback: fn => fn, useRef: value => ({ current: value }),
    createContext: value => ({ Provider: 'Provider', Consumer: 'Consumer', _value: value }),
    useContext: ctx => ctx && ctx._value,
  };
  m.require = id => id === '__fixture_hooks__' ? hooks
    : id === 'react' ? reactStub
    : id === 'react-native' ? { View: 'View', Text: 'Text', Pressable: 'Pressable' }
    : id === '@getpaseo/plugin/client/react-native' ? { ScrollView: 'ScrollView' }
    : id === '@tanstack/react-query' ? { useQuery: () => ({ data: undefined, isLoading: false, error: null, refetch() {} }) }
    : id === '@getpaseo/plugin/client' ? { useRpc: () => async () => undefined }
    : nativeRequire(id);
  m._compile(code, m.filename);
  return m.exports;
}

function render(node, out = []) {
  if (node == null || typeof node === 'boolean') return out;
  if (Array.isArray(node)) { node.forEach(n => render(n, out)); return out; }
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (typeof node.type === 'function') return render(node.type(node.props), out);
  if (node.type === 'Text') out.push(node.props);
  render(node.props?.children, out);
  return out;
}
function content(children) {
  return Array.isArray(children) ? children.map(content).join('') : children == null ? '' : String(children);
}

(async () => {
  const code = await bundle();
  const f = fixture(code, { suppressed: true });
  await f.request({ id: 'unconfirmed', name: 'ExitPlanMode', kind: 'plan', input: {} });
  const base = await f.read();
  base.permissions.auditRetention.evicted = 1;
  base.permissions.auditRetention.lastEvictedAt = '2026-10-19T00:00:00Z';
  for (const compact of [false, true]) for (const mode of ['light', 'dark']) {
    const colors = Object.fromEntries(['foreground', 'foregroundMuted', 'statusSuccess', 'statusWarning', 'statusDanger',
      'accent', 'accentForeground', 'border', 'surface0', 'surface1', 'surface2'].map(k => [k, `${mode}.${k}`]));
    const { StewardScreen, serverMessage } = await screenModule(base);
    const nodes = render(StewardScreen({ theme: { colors }, layout: { compact } }));
    const text = nodes.map(n => content(n.children)).join('\n');
    assert.match(text, /\u5df2\u8bb0\u5f55/); // Recorded.
    assert.match(text, /\u672a\u786e\u8ba4/); // Unconfirmed.
    assert.doesNotMatch(text, /\u5df2\u653e\u884c/); // Must not claim allowed.
    assert.match(text, /200/);
    assert.match(text, /\u7d2f\u8ba1\u6dd8\u6c70 1/); // One observable historical eviction.
    const status = nodes.find(n => /\u672a\u786e\u8ba4\u9001\u8fbe/.test(content(n.children)));
    assert.ok(status);
    assert.equal(status.numberOfLines, undefined, 'audit outcome must wrap fully at phone width');
    for (const n of nodes) assert.ok(Object.values(colors).includes(n.style?.color), 'every Text must use theme colors');
    assert.equal(status.style.fontSize, compact ? 14 : 13);
    assert.doesNotMatch(serverMessage('abc1234 ExitPlanMode (plan): allow; unconfirmed; recorded'), /allow|unconfirmed|recorded/);
    assert.doesNotMatch(serverMessage('abc1234 ExitPlanMode (plan): allow; not recorded — answer was not sent'), /allow|not recorded|answer was not sent/);
    console.log(`Surface PASS (${mode}, compact=${compact})`);
  }
  const broken = structuredClone(base);
  broken.onboarded = false; // Old audit and recovery diagnostics remain visible after offboarding.
  broken.permissions.auditError = 'EACCES';
  broken.permissions.audit[0].recorded = false;
  const { StewardScreen } = await screenModule(broken);
  const text = render(StewardScreen({ theme: { colors: { foreground: 'f', foregroundMuted: 'm', statusDanger: 'd' } }, layout: { compact: true } }))
    .map(n => content(n.children)).join('\n');
  assert.match(text, /\u5ba1\u8ba1\u672a\u8bb0\u5f55/); // Audit not recorded.
  assert.match(text, /EACCES/);
  assert.match(text, /\u672a\u8bb0\u5f55 \u00b7/);
  console.log('Recovery diagnostics PASS (non-onboarded screen)');
})().catch(error => { console.error(error); process.exitCode = 1; });
