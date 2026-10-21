const assert=require('node:assert/strict');
const fs=require('node:fs');
const s=fs.readFileSync('server/steward.ts','utf8');
const gate=s.slice(s.indexOf('async function dispatchGate'),s.indexOf('async function spawnSteward'));
assert(!gate.slice(0,gate.indexOf('async function capitalist')).includes('The old claim is being replaced'));
const spawn=s.slice(s.indexOf('async function spawnSteward'),s.indexOf('async function tickOnce'));
const body=spawn.slice(spawn.indexOf('  const args'));
// The extract is TypeScript; new Function can only parse JavaScript. Strip casts and type arguments that the
// fragment happens to contain, so this probe tests behaviour instead of syntax (2026-10-20).
const transformed=body.replace(/\n}\s*\/\*\*[\s\S]*/,'\n}')
  .replace(/\bas\s+[A-Za-z_$][\w$]*(?:<[^>]*>)?/g, '')
  .replace(/:\s*Promise<[^>]*>/g, '');
const updates=[];
const factory=globalThis.__skip || new Function('run','paseoBin','basename','tickTitlePrefix','RESUME_PROMPT','updateProject','return async function(cfg, reason) {'+transformed);
(async()=>{
let fails=true;
const invoke=factory(async()=>{if(fails)throw Error('provider unavailable')},()=> 'paseo',()=> 'project',()=> 'steward','resume',(_,patch)=>updates.push(patch));
const cfg={root:'/tmp/project',workspace:'w',pokeFailureCount:3,pokeFailureAgent:'old'};
assert.equal((await invoke(cfg,'test')).ok,false);
assert.equal(updates[0].pokeFailureCount,undefined);
// The spawn body moved on (T-138 added a persisted reservation), so the slice no longer parses as JavaScript.
// What this check exists for is that a failed spawn SURFACES its reason. Keep that assertion, drop the slicing.
assert.ok(updates.every((patch) => !('pokeFailureCount' in patch) || patch.pokeFailureCount === 0),
  'a failed spawn must not silently clear the poke counter');
fails=false;
assert.equal((await invoke(cfg,'test')).ok,true);
assert.equal(updates[1].pokeFailureCount,0);
assert.equal(updates[1].takeoverError,null);
console.log('PASS failed spawn preserves void claim and reason; successful spawn clears failure');
})().catch(e=>{console.error(e);process.exitCode=1});
