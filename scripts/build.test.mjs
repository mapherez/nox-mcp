import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

test('a clean build removes obsolete JS and declarations without modifying source',async t=>{
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const temp=await mkdtemp(resolve(tmpdir(),'nox-build-test-'));
  t.after(async()=>{assert.equal(dirname(temp),resolve(tmpdir()));await rm(temp,{recursive:true,force:true});});
  await mkdir(resolve(temp,'scripts'));await mkdir(resolve(temp,'typescript/dist'),{recursive:true});
  await cp(resolve(root,'scripts/build.mjs'),resolve(temp,'scripts/build.mjs'));
  await cp(resolve(root,'package.json'),resolve(temp,'package.json'));
  await cp(resolve(root,'typescript/src'),resolve(temp,'typescript/src'),{recursive:true});
  await cp(resolve(root,'typescript/tsconfig.json'),resolve(temp,'typescript/tsconfig.json'));
  await symlink(resolve(root,'node_modules'),resolve(temp,'node_modules'),process.platform==='win32'?'junction':'dir');
  for(const file of ['removed-entry.js','removed-entry.d.ts'])await writeFile(resolve(temp,'typescript/dist',file),'obsolete');
  const source=await readFile(resolve(temp,'typescript/src/index.ts'),'utf8');
  execFileSync(process.execPath,['scripts/build.mjs'],{cwd:temp,stdio:'pipe'});
  for(const file of ['removed-entry.js','removed-entry.d.ts'])await assert.rejects(readFile(resolve(temp,'typescript/dist',file)),{code:'ENOENT'});
  assert.ok((await readFile(resolve(temp,'typescript/dist/index.d.ts'),'utf8')).length>0);
  assert.equal(await readFile(resolve(temp,'typescript/src/index.ts'),'utf8'),source);
});
