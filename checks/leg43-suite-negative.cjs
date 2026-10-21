const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');

const repo=path.resolve(__dirname,'..'), suite=path.join(repo,'tools/suite.sh'), realChecks=path.join(repo,'checks');
const before=fs.readdirSync(realChecks).sort();

// Case 3 runs the real suite, which would otherwise re-enter this check forever.
if(process.env.LEG43_NESTED_SUITE==='1'){
  console.log('PASS nested leg43 skipped: the outer run already exercised this check');
  process.exit(0);
}

const run=(env)=>spawnSync(suite,[],{cwd:repo,encoding:'utf8',timeout:180000,env:{...process.env,...env}});
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'leg43-suite-'));
const plant=(name,body)=>{const dir=path.join(tmp,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'leg99-fake.cjs'),body);return dir};

const r1=run({SUITE_CHECKS_DIR:plant('exit42','console.log("failed on purpose");process.exit(42);\n')});
assert.notEqual(r1.status,0,`suite stayed green for a check that exited 42\n${r1.stdout}${r1.stderr}`);
assert.match(r1.stdout,/FAIL\s+leg99-fake\.cjs \(exit 42\)/);
assert.match(r1.stdout,/SUITE RED: 1 failing/);
console.log('PASS a check exiting 42 turns the suite red and is named in the output');

const r2=run({SUITE_CHECKS_DIR:plant('pass-then-exit1','console.log("PASS looks fine");process.exit(1);\n')});
assert.notEqual(r2.status,0,`suite trusted printed PASS over the exit code\n${r2.stdout}${r2.stderr}`);
assert.match(r2.stdout,/FAIL\s+leg99-fake\.cjs \(exit 1\)/);
assert.doesNotMatch(r2.stdout,/^PASS\s+leg99-fake\.cjs$/m);
assert.match(r2.stdout,/SUITE RED: 1 failing/);
console.log('PASS printed PASS followed by exit 1 still fails the suite');

assert.deepEqual(fs.readdirSync(realChecks).sort(),before,'a fake check leaked into the real checks/ directory');
for(const name of before) assert.ok(!name.includes('leg99-fake'),'fake check found in real checks/');

const r3=run({LEG43_NESTED_SUITE:'1'});
assert.equal(r3.status,0,`the real suite over checks/ is no longer green\n${r3.stdout}${r3.stderr}`);
assert.doesNotMatch(r3.stdout,/leg99-fake/);
assert.match(r3.stdout,/SUITE GREEN/);
console.log('PASS the real suite over checks/ stays green and never sees the fake check');

fs.rmSync(tmp,{recursive:true,force:true});
