const {execFileSync}=require('node:child_process'), fs=require('node:fs'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'t147-running-')), id='12345678-1234-1234-1234-123456789abc';
execFileSync('npx',['esbuild','server/steward.ts','--bundle','--platform=node','--format=cjs','--external:@getpaseo/*','--outfile='+path.join(tmp,'server.cjs')],{stdio:'ignore'});
process.env.NODE_PATH=process.cwd()+'/node_modules';require('node:module').Module._initPaths();
process.env.PASEO_STEWARD_CONFIG=path.join(tmp,'config.json');
process.env.PASEO_BIN=path.join(tmp,'paseo');
fs.writeFileSync(process.env.PASEO_BIN,`#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv[2]==='run'){fs.appendFileSync(${JSON.stringify(path.join(tmp,'spawns'))},'spawn\\n');console.log('87654321-1234-1234-1234-123456789abc');}
else console.log(fs.readFileSync(${JSON.stringify(path.join(tmp,'agents'))},'utf8'));
`,{mode:0o700});
const server=require(path.join(tmp,'server.cjs'));
(async()=>{
 for(const status of ['running','error','idle','unreadable']){
  const root=path.join(tmp,status);fs.mkdirSync(path.join(root,'control'),{recursive:true});
  fs.writeFileSync(path.join(root,'control/COMMAND.md'),`## Lease\nsession=test\npaseo-agent=${id}\nstate=held\n`);
  fs.writeFileSync(path.join(tmp,'agents'),status==='unreadable'?'invalid':JSON.stringify([{id,status}]));
  fs.writeFileSync(process.env.PASEO_STEWARD_CONFIG,JSON.stringify({projects:[{root,enabled:true,workspace:'w',lazyMode:true,pokeFailureAgent:id,pokeFailureCount:3}],audit:[],auditEvictions:{}}));
  const count=()=>fs.existsSync(path.join(tmp,'spawns'))?fs.readFileSync(path.join(tmp,'spawns'),'utf8').trim().split('\n').length:0;
  const before=count();console.log(...await server.tickOnce('manual',root));
  assert.equal(count()-before,['error','idle'].includes(status)?1:0,status);
  if(status==='running') assert.equal(JSON.parse(fs.readFileSync(process.env.PASEO_STEWARD_CONFIG)).projects[0].pokeFailureCount,3);
  console.log('PASS '+status+' claim at failed-poke limit');
 }
})().catch(e=>{console.error(e);process.exitCode=1});
