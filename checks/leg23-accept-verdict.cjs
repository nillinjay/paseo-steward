const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process'),crypto=require('node:crypto');
const repo=path.resolve(__dirname,'..'),tmp=fs.mkdtempSync('/tmp/leg23-'),root=tmp+'/project';
cp.execFileSync('npx',['esbuild','server/steward.ts','--bundle','--platform=node','--format=cjs','--outfile='+tmp+'/server.cjs','--external:@getpaseo/*'],{cwd:repo,stdio:'ignore'});
process.env.NODE_PATH=repo+'/node_modules';require('node:module')._initPaths();
fs.mkdirSync(root+'/control',{recursive:true});fs.mkdirSync(root+'/checks/out',{recursive:true});
fs.writeFileSync(root+'/control/COMMAND.md','# COMMAND\n## Dispatch ledger\n');
const git=(...args)=>cp.execFileSync('git',args,{cwd:root,encoding:'utf8'}).trim();
git('init','-q');git('add','.');git('-c','user.name=test','-c','user.email=test@example.invalid','commit','-qm','fixture');
const sha=git('rev-parse','HEAD');
process.env.PASEO_STEWARD_CONFIG=tmp+'/config.json';fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG,JSON.stringify({projects:[],audit:[]}));
process.env.PASEO_BIN=tmp+'/paseo';fs.writeFileSync(process.env.PASEO_BIN,"#!/bin/sh\nprintf '[]\\n'\n");fs.chmodSync(process.env.PASEO_BIN,0o755);
const server=require(tmp+'/server.cjs');
const write=(verdict,commit=sha,scope=true,gate=true)=>fs.writeFileSync(root+'/checks/out/T-test-'+commit+'.json',JSON.stringify({task:'T-test',commit,verdict,provenance:{clean:true,commit},scope:{pass:scope},gate:{pass:gate,commands:[{cmd:'true',exit_code:0}]}}));
function digest(dir) {const h=crypto.createHash('sha256');function walk(p){for(const n of fs.readdirSync(p).sort()){const f=path.join(p,n);if(fs.statSync(f).isDirectory())walk(f);else h.update(f).update(fs.readFileSync(f));}}walk(dir);return h.digest('hex');}
(async()=>{
 for(const [verdict,scope,gate,ok] of [['FAIL',true,true,false],['PASS',false,true,false],['PASS',true,false,false],['PASS',true,true,true]]){
  write(verdict,sha,scope,gate);const before=digest(root);
  const result=await server.controlSteward({action:'accept',project:root,task:'T-test',commit:sha});
  assert.equal(result.ok,ok);
  if(ok){assert.equal(result.targetPath,root+'/control/COMMAND.md');assert.match(result.proposedRow,/review pending/);}
  const state=await server.readSteward({project:root});assert.equal(state.acceptance[0].allCommandsPassed,ok);
  assert.equal(digest(root),before);
 }
 write('PASS','c'.repeat(40));assert.equal((await server.controlSteward({action:'accept',project:root,task:'T-test',commit:'c'.repeat(40)})).ok,false);
 console.log('PASS N3 aggregate verdict and repository commit; N4 accept/read tree hash unchanged');
})().catch(e=>{console.error(e);process.exitCode=1});
