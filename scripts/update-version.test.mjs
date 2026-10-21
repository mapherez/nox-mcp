import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {copyFile,mkdir,mkdtemp,readFile,rm,symlink,unlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {readVersionFiles,updateVersion} from './update-version.mjs';
import {release} from './release.mjs';

function git(root,...args){return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();}
export async function repository(t){
  const root=await mkdtemp(resolve(tmpdir(),'nox-version-test-'));
  t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  await mkdir(resolve(root,'rust'));await mkdir(resolve(root,'scripts'));
  for(const file of ['update-version.mjs','release.mjs'])await copyFile(new URL(file,import.meta.url),resolve(root,'scripts',file));
  await writeFile(resolve(root,'package.json'),JSON.stringify({name:'@nox/mcp',version:'0.3.0',dependencies:{example:'0.1.0'}})+'\n');
  await writeFile(resolve(root,'package-lock.json'),JSON.stringify({name:'@nox/mcp',version:'0.2.0',lockfileVersion:3,packages:{'':{name:'@nox/mcp',version:'0.2.0'},'node_modules/example':{version:'0.1.0'}}})+'\n');
  await writeFile(resolve(root,'rust/Cargo.toml'),'[package]\r\nname = "nox-mcp"\r\nversion = "0.1.0"\r\nrust-version = "1.88"\r\n\r\n[dependencies]\r\nexample = "0.1.0"\r\n');
  await writeFile(resolve(root,'rust/Cargo.lock'),'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0"\n\n[[package]]\nname = "nox-mcp"\nversion = "0.1.0"\n');
  await writeFile(resolve(root,'go.mod'),'module github.com/mapherez/nox-mcp\n\ngo 1.26.0\n');
  git(root,'init','--initial-branch=master');
  for(const[key,value]of Object.entries({'user.name':'Version test','user.email':'version@example.invalid','commit.gpgsign':'false','tag.gpgsign':'false','core.autocrlf':'false','core.hooksPath':resolve(root,'no-hooks')}))git(root,'config',key,value);
  git(root,'add','.');git(root,'commit','-m','Initial fixture');return root;
}
async function origin(t,root){
  const remote=await mkdtemp(resolve(tmpdir(),'nox-release-origin-'));
  t.after(async()=>{assert.equal(dirname(remote),resolve(tmpdir()));await rm(remote,{recursive:true,force:true});});
  git(remote,'init','--bare','--initial-branch=master');git(root,'remote','add','origin',remote);return remote;
}
async function prepared(root,version){for(const file of await readVersionFiles(root))await writeFile(resolve(root,file.path),file.render(version));git(root,'add','.');git(root,'commit','-m',`Prepare ${version}`);}

test('version preparation synchronizes only project versions, preserving dependencies and line endings, without tags',async t=>{
  const root=await repository(t),initial=await readVersionFiles(root),head=git(root,'rev-parse','HEAD');
  assert.equal(await updateVersion(root,'v0.4.0-beta.1'),'v0.4.0-beta.1');
  for(const file of await readVersionFiles(root)){
    assert.ok(file.versions.every(v=>v==='0.4.0-beta.1'));
    assert.equal(git(root,'show',`HEAD:${file.path}`).replaceAll('\r\n','\n'),file.original.replaceAll('\r\n','\n').trim());
  }
  assert.notEqual(git(root,'rev-parse','HEAD'),head);assert.equal(git(root,'tag','--list'),'');assert.equal(git(root,'status','--porcelain'),'');
  assert.equal(JSON.parse(await readFile(resolve(root,'package.json'))).dependencies.example,'0.1.0');
  assert.equal(JSON.parse(await readFile(resolve(root,'package-lock.json'))).packages['node_modules/example'].version,'0.1.0');
  assert.equal(await readFile(resolve(root,'rust/Cargo.toml'),'utf8'),initial[2].original.replace('version = "0.1.0"','version = "0.4.0-beta.1"'));
  assert.equal(await readFile(resolve(root,'rust/Cargo.lock'),'utf8'),initial[3].original.replace('name = "nox-mcp"\nversion = "0.1.0"','name = "nox-mcp"\nversion = "0.4.0-beta.1"'));
});
test('filesystem aliases are accepted but a subdirectory in a parent repository is rejected',async t=>{
  const root=await repository(t),alias=root+'-alias';await symlink(root,alias,process.platform==='win32'?'junction':'dir');t.after(()=>unlink(alias));
  await updateVersion(alias,'0.4.0');
  const child=resolve(root,'nested');await mkdir(resolve(child,'rust'),{recursive:true});
  for(const file of ['package.json','package-lock.json','rust/Cargo.toml','rust/Cargo.lock','go.mod'])await copyFile(resolve(root,file),resolve(child,file));
  git(root,'add','.');git(root,'commit','-m','Nested fixture');const head=git(root,'rev-parse','HEAD');
  await assert.rejects(updateVersion(child,'0.5.0'),/repositorio pai/);assert.equal(git(root,'rev-parse','HEAD'),head);assert.equal(git(root,'status','--porcelain'),'');
});
test('invalid versions, incompatible Go majors, existing tags and dirty trees change nothing',async t=>{
  const root=await repository(t),initial=await readVersionFiles(root),head=git(root,'rev-parse','HEAD');
  for(const v of ['bad','0.04.0','0.4.0-01','0.4.0\nextra','0.4.0+build'])await assert.rejects(updateVersion(root,v),/Versao invalida/);
  await assert.rejects(updateVersion(root,'2.0.0'),/module path Go/);
  git(root,'tag','v0.4.0');await assert.rejects(updateVersion(root,'0.4.0'),/ja existe/);
  await writeFile(resolve(root,'uncommitted.txt'),'keep');await assert.rejects(updateVersion(root,'0.5.0'),/commit ou stash/);
  assert.deepEqual((await readVersionFiles(root)).map(f=>f.original),initial.map(f=>f.original));assert.equal(git(root,'rev-parse','HEAD'),head);
});
test('failed commits restore only version edits and create no tags',async t=>{
  const root=await repository(t),initial=await readVersionFiles(root);
  git(root,'config','core.hooksPath',resolve(root,'.git/hooks'));await writeFile(resolve(root,'.git/hooks/pre-commit'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await assert.rejects(updateVersion(root,'0.4.0'));assert.deepEqual((await readVersionFiles(root)).map(f=>f.original),initial.map(f=>f.original));assert.equal(git(root,'status','--porcelain'),'');assert.equal(git(root,'tag','--list'),'');
});
test('interactive version preparation works outside the repository and creates no tag',async t=>{
  const root=await repository(t);
  const r=spawnSync(process.execPath,[resolve(root,'scripts/update-version.mjs')],{cwd:tmpdir(),input:'0.4.0\n',encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Existem versoes inconsistentes/);assert.match(r.stdout,/sem tag/);assert.equal(git(root,'tag','--list'),'');
});
test('interactive release cancellation or invalid input never prepares or pushes a commit',async t=>{
  const root=await repository(t),head=git(root,'rev-parse','HEAD');
  for(const input of ['\n','','  \n']){
    const r=spawnSync(process.execPath,[resolve(root,'scripts/release.mjs')],{cwd:tmpdir(),input,encoding:'utf8',timeout:30000});
    assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/Versao a publicar/);assert.match(r.stdout,/Cancelado/);
  }
  const invalid=spawnSync(process.execPath,[resolve(root,'scripts/release.mjs'),'bad'],{encoding:'utf8'});assert.equal(invalid.status,1);assert.match(invalid.stderr,/Versao invalida/);
  const extra=spawnSync(process.execPath,[resolve(root,'scripts/release.mjs'),'0.4.0','extra'],{encoding:'utf8'});assert.equal(extra.status,1);assert.match(extra.stderr,/Uso:/);
  assert.equal(git(root,'rev-parse','HEAD'),head);assert.equal(git(root,'status','--porcelain'),'');
});
test('release pushes only the exact prepared SHA to master, even with push.followTags enabled',async t=>{
  const root=await repository(t),remote=await origin(t,root),head=git(root,'rev-parse','HEAD');let checked=false;
  git(root,'tag','-a','unrelated','-m','Do not push');git(root,'config','push.followTags','true');
  const url=await release(root,'0.4.0',{check:()=>{assert.equal(git(root,'rev-parse','HEAD'),head);assert.equal(git(remote,'for-each-ref'),'');checked=true;}});
  assert.ok(checked);assert.equal(url,'https://github.com/mapherez/nox-mcp/releases/download/v0.4.0/nox-mcp.tgz');
  assert.equal(git(remote,'rev-parse','refs/heads/master'),git(root,'rev-parse','HEAD'));assert.equal(git(remote,'tag','--list'),'');assert.equal(git(root,'tag','--list'),'unrelated');
  assert.equal(git(root,'log','-1','--format=%B'),'chore: release v0.4.0\n\nNoX-Release: 0.4.0');
});
test('release of a prepared version records intent once and retry reuses the same SHA',async t=>{
  const root=await repository(t),remote=await origin(t,root);await prepared(root,'0.5.0');const preparedHead=git(root,'rev-parse','HEAD');
  await assert.rejects(updateVersion(root,'0.5.0'),/ja usam essa versao/);
  await release(root,'0.5.0');const head=git(root,'rev-parse','HEAD');assert.notEqual(head,preparedHead);
  await release(root,'0.5.0');assert.equal(git(root,'rev-parse','HEAD'),head);assert.equal(git(remote,'rev-parse','master'),head);assert.equal(git(remote,'tag','--list'),'');
});
test('failed preflight restores version files before any commit or push',async t=>{
  const root=await repository(t),remote=await origin(t,root),head=git(root,'rev-parse','HEAD'),initial=await readVersionFiles(root);
  await assert.rejects(release(root,'0.4.0',{check:()=>{throw Error('Preflight failed');}}),/Preflight failed/);
  assert.equal(git(root,'rev-parse','HEAD'),head);assert.deepEqual((await readVersionFiles(root)).map(f=>f.original),initial.map(f=>f.original));assert.equal(git(remote,'for-each-ref'),'');
});
test('preflight cannot leave unrelated tracked, staged or untracked changes',async t=>{
  for(const kind of ['tracked','staged','untracked'])await t.test(kind,async t=>{
    const root=await repository(t),remote=await origin(t,root),head=git(root,'rev-parse','HEAD');
    await assert.rejects(release(root,'0.4.0',{check:async()=>{const file=kind==='untracked'?'unexpected.txt':'go.mod';await writeFile(resolve(root,file),'preserve');if(kind==='staged')git(root,'add',file);}}),/validacao alterou ficheiros/);
    assert.equal(git(root,'rev-parse','HEAD'),head);assert.equal(git(remote,'for-each-ref'),'');assert.equal(await readFile(resolve(root,kind==='untracked'?'unexpected.txt':'go.mod'),'utf8'),'preserve');
  });
});
test('remote tags, non-master branches, detached HEAD and rejected pushes cannot publish',async t=>{
  const root=await repository(t),remote=await origin(t,root),initial=git(root,'rev-parse','HEAD');
  git(root,'tag','v0.4.0');git(root,'push','origin','refs/tags/v0.4.0');git(root,'tag','-d','v0.4.0');
  await assert.rejects(release(root,'0.4.0'),/ja existe em origin/);assert.equal(git(root,'rev-parse','HEAD'),initial);
  git(root,'checkout','-b','feature');await assert.rejects(release(root,'0.5.0'),/branch master/);
  git(root,'checkout','--detach',initial);await assert.rejects(release(root,'0.5.0'));git(root,'checkout','master');
  await writeFile(resolve(remote,'hooks/pre-receive'),'#!/bin/sh\nexit 1\n',{mode:0o755});
  await assert.rejects(release(root,'0.5.0'),/Push falhou.*sem criar tags/);assert.equal(git(root,'tag','--list'),'');assert.notEqual(git(root,'rev-parse','HEAD'),initial);assert.equal(git(remote,'tag','--list'),'v0.4.0');
});
test('a concurrent master update rejects the non-fast-forward preparation push without changing remote tags',async t=>{
  const root=await repository(t),remote=await origin(t,root);
  git(root,'push','origin','HEAD:refs/heads/master');
  const initial=git(root,'rev-parse','HEAD'),tree=git(root,'rev-parse','HEAD^{tree}');
  const concurrent=git(root,'commit-tree',tree,'-p',initial,'-m','Concurrent master change');
  git(root,'push','origin',`${concurrent}:refs/heads/master`);
  await assert.rejects(release(root,'0.5.0'),/Push falhou.*sem criar tags/);
  assert.equal(git(remote,'rev-parse','master'),concurrent);assert.equal(git(remote,'tag','--list'),'');
  assert.equal(git(root,'log','-1','--format=%B'),'chore: release v0.5.0\n\nNoX-Release: 0.5.0');
});
test('Go major validation and detached CI version validation remain strict',async t=>{
  const root=await repository(t);await writeFile(resolve(root,'go.mod'),'module github.com/mapherez/nox-mcp/v2\n\ngo 1.26.0\n');git(root,'add','.');git(root,'commit','-m','Go major migration');
  await assert.rejects(updateVersion(root,'1.0.0'),/module path Go/);await assert.rejects(updateVersion(root,'3.0.0'),/module path Go/);await updateVersion(root,'2.0.0');
  git(root,'checkout','--detach','HEAD');const check=tag=>spawnSync(process.execPath,[fileURLToPath(new URL('./check-release-version.mjs',import.meta.url)),tag],{cwd:root,encoding:'utf8'});
  assert.equal(check('v2.0.0').status,0);assert.equal(check('v2.1.0').status,1);assert.equal(check('2.0.0').status,1);
});
