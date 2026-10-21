const {execFileSync}=require('node:child_process');
const assert=require('node:assert/strict');
execFileSync('npx',['esbuild','server/steward.ts','--bundle','--platform=node','--format=cjs','--external:@getpaseo/*','--outfile=/tmp/t147-shell.cjs'],{stdio:'ignore'});
process.env.NODE_PATH=process.cwd()+'/node_modules'; require('node:module').Module._initPaths();
const {destructiveOperation}=require('/tmp/t147-shell.cjs');
for(const command of ["time rm -rf /tmp/victim","nohup rm -rf /tmp/victim","r''m -rf /tmp/victim","git reset --ha''rd HEAD","ls; rm -rf x",'r\\m -rf x','sh -c "rm -rf x"']) assert.ok(destructiveOperation(JSON.stringify({command}),process.cwd()),command);
for (const command of ['$(echo rm) x', '`echo rm` x', '$CMD x', 'cat <<EOF']) assert.equal(destructiveOperation(command, process.cwd()), null);
assert.equal(destructiveOperation('git status',process.cwd()),null);
console.log('PASS quoted and escaped operations, compound commands, unresolved syntax pending; git status allowed');
