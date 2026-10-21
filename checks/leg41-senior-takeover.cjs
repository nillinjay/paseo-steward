const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync } = require('node:child_process');
const { buildSync } = require('esbuild');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leg41-'));
process.env.PASEO_STEWARD_CONFIG = path.join(tmp, 'config.json');
process.env.NODE_PATH = path.resolve('node_modules'); require('node:module').Module._initPaths();
for (const name of ['shared', 'server']) buildSync({entryPoints:[`${name}/steward.ts`],bundle:true,platform:'node',format:'cjs',external:['@getpaseo/*'],outfile:path.join(tmp,`${name}.cjs`)});
const { strikeOutcome, ProjectConfigSchema } = require(path.join(tmp, 'shared.cjs'));
const server = require(path.join(tmp, 'server.cjs'));
const failure = (code, fingerprint='same') => ({ code, fingerprint, at:'2026-10-21T00:00:00Z' });
for (const code of ['E_LOGIC','E_ENV','E_FLAKY','E_UNKNOWN']) {
 for (const previous of ['E_LOGIC','E_ENV','E_FLAKY','E_UNKNOWN']) {
  for (const fingerprint of ['same','different']) {
   const result = strikeOutcome([failure(previous)], failure(code,fingerprint));
   assert.equal(result.escalate, code==='E_LOGIC' && previous==='E_LOGIC' && fingerprint==='same');
   assert.equal(result.strikes, ['E_ENV','E_FLAKY'].includes(code)?0:result.escalate?2:1);
  }
 }
}
assert.equal(strikeOutcome([failure('E_LOGIC'),failure('E_ENV')],failure('E_LOGIC')).escalate,false);
assert.equal(strikeOutcome([failure('E_UNKNOWN'),failure('E_UNKNOWN')],failure('E_UNKNOWN')).escalate,false);
assert.match(strikeOutcome([],failure('E_UNKNOWN')).reason,/once.*never escalates/);
assert.equal(strikeOutcome([failure('E_LOGIC'),failure('E_LOGIC')],failure('E_LOGIC')).escalate,false);
const root = path.join(tmp,'project'); fs.mkdirSync(path.join(root,'checks/out'),{recursive:true});
execFileSync('git',['init',root],{stdio:'ignore'});
execFileSync('git',['-c','user.name=Probe','-c','user.email=probe@example.test','commit','--allow-empty','-m','fixture'],{cwd:root,stdio:'ignore'});
const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG,JSON.stringify({projects:[{root}],audit:[],auditEvictions:{}}));
const record = (task,code,id,fingerprint='same') => server.recordTaskFailure(root,{task,attempt:'junior-1',worktree:root,reportId:id,commit,...failure(code,fingerprint)});
for (const [task,codes] of [['logic',['E_LOGIC','E_LOGIC']],['env',['E_LOGIC','E_ENV','E_LOGIC']],['unknown',['E_UNKNOWN','E_UNKNOWN','E_UNKNOWN']]]) {
 codes.forEach((code,i)=>record(task,code,`${task}-${i}`));
}
record('different','E_LOGIC','d1'); assert.equal(record('different','E_LOGIC','d2','new').strikes,1);
const cfg = JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG)).projects[0];
assert.ok(cfg.taskFailures.logic.every(row=>row.disqualified));
assert.deepEqual(ProjectConfigSchema.parse(cfg).taskFailures, cfg.taskFailures);
assert.equal(cfg.taskFailures.logic[1].escalation.toProfile,'senior-sol');
assert.equal(cfg.taskFailures.logic[1].escalation.worktree,root);
assert.ok(cfg.taskFailures.env.every(row=>!row.escalate));
assert.ok(cfg.taskFailures.unknown.every(row=>!row.escalate));
record('logic','E_LOGIC','logic-1');
assert.equal(JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG)).projects[0].taskFailures.logic.length,2);
const artifact = {task:'logic',attempt_id:'junior-1',commit,verdict:'PASS',scope:{pass:true},gate:{pass:true,commands:[{cmd:'true',exitCode:0}]},provenance:{clean:true,commit}};
const artifactPath = path.join(root,'checks/out',`logic-${commit}.json`);
fs.writeFileSync(artifactPath,JSON.stringify(artifact));
assert.equal(server.acceptanceState(root,commit).find(row=>row.task==='logic').status,'failed');
assert.equal(server.acceptanceState(root,commit).find(row=>row.task==='logic').allCommandsPassed,false);
(async()=>{
 assert.equal((await server.controlSteward({action:'accept',project:root,task:'logic',commit})).ok,false);
 artifact.attempt_id='senior-1'; fs.writeFileSync(artifactPath,JSON.stringify(artifact));
 assert.equal(server.acceptanceState(root,commit).find(row=>row.task==='logic').status,'certified');
 console.log('PASS leg41: full strike truth table; persisted decisions; same worktree senior handover; disqualified acceptance refused; new attempt certified');
})().catch(error=>{console.error(error);process.exitCode=1});
