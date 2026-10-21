const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),cp=require('node:child_process');
const repo=path.resolve(__dirname,'..'), tmp=fs.mkdtempSync('/tmp/leg22-');
cp.execFileSync('npx',['esbuild','server/steward.ts','--bundle','--platform=node','--format=cjs','--outfile='+tmp+'/server.cjs','--external:@getpaseo/*'],{cwd:repo,stdio:'ignore'});
process.env.NODE_PATH=repo+'/node_modules';require('node:module')._initPaths();
const root=tmp+'/project';fs.mkdirSync(root+'/control',{recursive:true});fs.writeFileSync(root+'/control/COMMAND.md','# COMMAND');
process.env.PASEO_STEWARD_CONFIG=tmp+'/config.json';
fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG,JSON.stringify({projects:[{root,autoAllowShell:true}],audit:[]}));
process.env.PASEO_BIN=tmp+'/paseo';
fs.writeFileSync(process.env.PASEO_BIN,'#!/usr/bin/env node\nconst root='+JSON.stringify(root)+'; console.log(JSON.stringify(process.argv[2]==="permit"?[{id:"p",agentId:"worker",name:"CodexBash"}]:process.argv[2]==="agent"?[{id:"worker",cwd:root}]:process.argv[2]==="workspace"?[{workspaceId:"main",project:"project",cwd:root,isolation:"local"}]:[]))');fs.chmodSync(process.env.PASEO_BIN,0o755);
const server=require(tmp+'/server.cjs');
(async()=>{
 let answers=[],request;
 const ref={cwd:root,refresh:async()=>({agent:{pendingPermissions:request?[request]:[]}}),respondToPermission:async r=>{answers.push(r);request=null}};
 const context={paseo:{agents:{ref:()=>ref}}};
 function scopeInput(description) {
  const paths=description.replace(/^Scope:\s*/,'').split(',').map(s=>s.trim()).filter(Boolean);
  return {patterns:paths,directories:paths.map(p=>p.replace(/\/\*$/,''))};
 }
 async function event(description,name='external_directory',input) {
  if(input===undefined) input=name==='external_directory'?scopeInput(description):{};
  request={id:'p',kind:'tool',name,description,input};answers=[];
  await server.onPermissionRequested({agent:{id:'worker',cwd:root},request},context);
  return answers[0]?.response.behavior;
 }
 assert.equal(await event('Scope: /tmp/../home/private/*'),undefined);
 assert.equal(await event('Scope: /home/dev/code/paseo/../private/*'),undefined);
 fs.mkdirSync(tmp+'/nested');
 assert.equal(await event('Scope: '+tmp+'/nested/*'),'allow');
 fs.symlinkSync('/home',tmp+'/escape');
 assert.equal(await event('Scope: '+tmp+'/escape/*'),undefined);
 for(const [name,input,description,expected] of [
  ['CodexBash',{command:'google-chrome'},'run command','deny'],
  ['external_directory',scopeInput('Scope: '+tmp+'/nested/*'),'Scope: '+tmp+'/nested/*','allow']
 ]) {
  assert.equal(await event(description,name,input),expected);
  request={id:'p',kind:'tool',name,input:input ?? scopeInput(description),description};answers=[];
  await server.controlSteward({action:'answer-pending',project:root},context);
  assert.equal(answers[0]?.response.behavior,expected);
 }
 answers=[];ref.refresh=async()=>{throw Error('snapshot unavailable')};
 await server.controlSteward({action:'answer-pending',project:root},context);
 assert.equal(answers.length,0);
 console.log('PASS N1 snapshot failure, browser/scratch parity; N2 traversal, nested path, symlink');
})().catch(e=>{console.error(e);process.exitCode=1});
