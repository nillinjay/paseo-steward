#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'steward-leg27-'));
const id = '12345678-1234-1234-1234-123456789abc';
function pass(name) { console.log('PASS  ' + name); }
async function main() {
  const bundle = path.join(tmp, 'server.cjs');
  execFileSync('npx', ['esbuild', 'server/steward.ts', '--bundle', '--platform=node', '--format=cjs', '--external:@getpaseo/*', '--outfile=' + bundle], {cwd: repo, stdio: 'pipe'});
  process.env.NODE_PATH = path.join(repo, 'node_modules');
  require('node:module').Module._initPaths();
  process.env.PASEO_STEWARD_CONFIG = path.join(tmp, 'config.json');
  const root = path.join(tmp, 'project');
  fs.mkdirSync(path.join(root, 'control'), {recursive:true});
  const command = path.join(root, 'control/COMMAND.md');
  fs.writeFileSync(command, '## Lease\nsession=test\npaseo-agent=none\n');
  const cli = path.join(tmp, 'paseo');
  fs.writeFileSync(cli, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='run') {fs.appendFileSync(${JSON.stringify(path.join(tmp,'spawns'))},'spawn\\n'); if(fs.existsSync(${JSON.stringify(path.join(tmp,'uncertain'))})) process.exit(1); console.log('${id}');}
else console.log(fs.readFileSync(${JSON.stringify(path.join(tmp,'agents'))},'utf8'));
`, {mode:0o700});
  fs.writeFileSync(path.join(tmp,'agents'), JSON.stringify([{id}]));
  process.env.PASEO_BIN = cli;
  fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG, JSON.stringify({projects:[{root,enabled:true,workspace:'w',lazyMode:true}],audit:[],auditEvictions:{}}));
  let server = require(bundle);
  const tick = async () => console.log(...await server.tickOnce('manual',root));
  await tick();
  delete require.cache[require.resolve(bundle)]; server = require(bundle);
  await tick();
  assert.equal(fs.readFileSync(path.join(tmp,'spawns'),'utf8').trim().split('\n').length,1);
  pass('two sequential manual ticks, including reload before claim, spawn exactly once');
  fs.writeFileSync(command, `## Lease\nsession=test\npaseo-agent=${id}\nstate=held\n`);
  await tick();
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG)).spawnReservations).length,0);
  fs.writeFileSync(path.join(tmp,'agents'),'[]');
  await tick();
  assert.equal(fs.readFileSync(path.join(tmp,'spawns'),'utf8').trim().split('\n').length,2);
  pass('verified published claim reconciles; later absent steward can be replaced');
  // Start a separate project to verify pre-execution failure without altering pending intent.
  const file = JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG));
  const second = path.join(tmp,'second'); fs.mkdirSync(path.join(second,'control'),{recursive:true});
  fs.writeFileSync(path.join(second,'control/COMMAND.md'),'## Lease\nsession=test\npaseo-agent=none\n');
  file.projects.push({...file.projects[0],root:second,lastDispatchAt:null});
  fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG,JSON.stringify(file));
  process.env.PASEO_BIN = path.join(tmp,'missing-cli');
  console.log(...await server.tickOnce('manual',second));
  assert.equal(JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG)).spawnReservations[second],undefined);
  pass('verified failure to execute clears reservation');
  process.env.PASEO_BIN=cli; fs.writeFileSync(path.join(tmp,'uncertain'),'');
  console.log(...await server.tickOnce('manual',second));
  assert.ok(JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG)).spawnReservations[second]);
  console.log(...await server.tickOnce('manual',second));
  assert.equal(fs.readFileSync(path.join(tmp,'spawns'),'utf8').trim().split('\n').length,3);
  pass('uncertain nonzero launch outcome keeps refusing');
  const modelBundle = path.join(tmp, 'model.cjs');
  execFileSync('npx', ['esbuild', 'client/model.ts', '--bundle', '--platform=node', '--format=cjs', '--outfile=' + modelBundle], {cwd:repo,stdio:'pipe'});
  const {stewardStatus} = require(modelBundle);
  const state = {onboarded:true, agentsReadable:true,
    lease:{claimed:true,agentPresent:true,paseoAgent:id,heartbeatAgeMinutes:0},
    config:{pendingWakes:[]},warnings:[],dispatchLock:null,liveAgents:[{id:'worker',status:'running'}],
    permissions:{readable:true,auditError:null,idleWithPending:0,pending:[{agentId:'worker',agentStatus:'running'}]}};
  assert.equal(stewardStatus(state).tone,'warning');
  assert.match(stewardStatus(state).detail,/权限/);
  pass('running worker with current pending permission shows warning');
  state.permissions.pending=[];
  assert.equal(stewardStatus(state).tone,'success');
  pass('removing pending request clears warning without changing worker status');
  console.log('OK');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
