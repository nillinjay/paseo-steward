const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const doc = path.join(repo, 'docs/V1.1-BWRAP-PROBE.md');
const version = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });

if (version.error && version.error.code === 'ENOENT') {
  const text = fs.existsSync(doc) ? fs.readFileSync(doc, 'utf8') : '';
  if (/bwrap[^\n]*(not installed|absent|missing)/i.test(text) || /host_lacked_bwrap:\s*true/i.test(text)) {
    console.log('PASS bwrap is absent and the probe document records that the host lacked it');
    process.exit(0);
  }
  console.error('FAIL bwrap is not installed and docs/V1.1-BWRAP-PROBE.md does not record that the host lacked it');
  process.exit(1);
}
assert.equal(version.status, 0, `bwrap --version failed: ${version.stderr}`);
const missingNamespace = require('./preconditions.cjs').missingBwrapNamespace();
if (missingNamespace) require('./preconditions.cjs').skip(missingNamespace);

const scratch = '/tmp/scratch';
const createdScratch = !fs.existsSync(scratch);
if (createdScratch) fs.mkdirSync(scratch, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leg46-bwrap-'));
const escapePath = `/tmp/leg46-escape-${process.pid}`;

const sandbox = (command, args, timeout = 60000) =>
  spawnSync(
    'bwrap',
    [
      '--ro-bind', '/', '/',
      '--bind', tmp, tmp,
      '--dev', '/dev',
      '--proc', '/proc',
      '--tmpfs', '/tmp/scratch',
      '--unshare-pid',
      '--die-with-parent',
      '--chdir', tmp,
      '--',
      command,
      ...args,
    ],
    { encoding: 'utf8', timeout },
  );

try {
  const escaped = sandbox('sh', ['-c', `printf escape > ${escapePath}`]);
  assert.notEqual(escaped.status, 0, `a write outside the bound worktree succeeded\n${escaped.stdout}${escaped.stderr}`);
  assert.match(escaped.stderr, /Read-only file system/, `unexpected denial text: ${escaped.stderr}`);
  assert.equal(fs.existsSync(escapePath), false, `the escaped file ${escapePath} exists on the host`);
  console.log('PASS a write outside the bound worktree fails with "Read-only file system" and leaves nothing on the host');

  const scratchWrite = sandbox('sh', ['-c', 'printf scratch > /tmp/scratch/leg46 && cat /tmp/scratch/leg46']);
  assert.equal(scratchWrite.status, 0, `a write to /tmp/scratch failed\n${scratchWrite.stdout}${scratchWrite.stderr}`);
  assert.equal(scratchWrite.stdout, 'scratch');
  assert.equal(fs.existsSync(path.join(scratch, 'leg46')), false, '/tmp/scratch/leg46 leaked to the host');
  console.log('PASS a write to /tmp/scratch succeeds inside a private tmpfs');

  const init = spawnSync('git', ['init', '-q', '-b', 'main', tmp], { encoding: 'utf8' });
  assert.equal(init.status, 0, `git init failed: ${init.stderr}`);
  const base = spawnSync(
    'git',
    ['-C', tmp, '-c', 'user.name=Probe', '-c', 'user.email=probe@example.test', 'commit', '--allow-empty', '-q', '-m', 'base'],
    { encoding: 'utf8' },
  );
  assert.equal(base.status, 0, `fixture commit failed: ${base.stderr}`);

  const commit = sandbox('sh', [
    '-c',
    'printf one > probe.txt && git add probe.txt && ' +
      'git -c user.name=Probe -c user.email=probe@example.test commit -q -m "leg46 commit" && ' +
      'git log -1 --pretty=%s',
  ]);
  assert.equal(commit.status, 0, `a git commit inside the sandbox failed\n${commit.stdout}${commit.stderr}`);
  assert.match(commit.stdout, /leg46 commit/);
  const subject = spawnSync('git', ['-C', tmp, 'log', '-1', '--pretty=%s'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(subject, 'leg46 commit', 'the commit did not persist in the bound worktree');
  console.log('PASS a git worktree remains committable inside the sandbox and the commit persists');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(escapePath, { force: true });
  if (createdScratch) fs.rmSync(scratch, { recursive: false, force: true });
}
