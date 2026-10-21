import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {test} from 'node:test';
import {githubAPI,publishRelease} from './publish-release.mjs';
import {releaseVersion,requiredJobs,workflowName,workflowPath} from './release-policy.mjs';

async function fixture(t,{intent=true}={}) {
  const root=await mkdtemp(resolve(tmpdir(),'nox-publisher-test-'));
  t.after(async()=>{assert.equal(dirname(root),resolve(tmpdir()));await rm(root,{recursive:true,force:true});});
  await mkdir(resolve(root,'rust'));
  await writeFile(resolve(root,'package.json'),JSON.stringify({name:'@nox/mcp',version:'0.7.0'}));
  await writeFile(resolve(root,'package-lock.json'),JSON.stringify({name:'@nox/mcp',version:'0.7.0',packages:{'':{name:'@nox/mcp',version:'0.7.0'}}}));
  await writeFile(resolve(root,'rust/Cargo.toml'),'[package]\nname = "nox-mcp"\nversion = "0.7.0"\n');
  await writeFile(resolve(root,'rust/Cargo.lock'),'[[package]]\nname = "nox-mcp"\nversion = "0.7.0"\n');
  await writeFile(resolve(root,'go.mod'),'module github.com/mapherez/nox-mcp\ngo 1.26.0\n');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','--initial-branch=master');
  for(const[k,v]of Object.entries({'user.name':'Publisher test','user.email':'publisher@example.invalid','commit.gpgsign':'false','core.hooksPath':resolve(root,'no-hooks')}))git('config',k,v);
  git('add','.');git('commit','-m',intent?'chore: release v0.7.0\n\nNoX-Release: 0.7.0':'Ordinary commit');
  const sha=git('rev-parse','HEAD'),repository='mapherez/nox-mcp',runId=17;
  const f={root,sha,repository,runId,calls:[],bytes:Buffer.from('package fixture'),packaged:false,branch:sha,tag:null,existingRelease:null};
  f.run={id:runId,run_attempt:1,workflow_id:42,name:workflowName,path:workflowPath,head_sha:sha,head_branch:'master',head_repository:{full_name:repository},repository:{full_name:repository},event:'push',status:'completed',conclusion:'success',html_url:'https://github.com/mapherez/nox-mcp/actions/runs/17'};
  f.jobs=requiredJobs.map(name=>({name,run_id:runId,head_sha:sha,status:'completed',conclusion:'success'}));
  f.packDistribution=async()=>{f.packaged=true;return{version:'0.7.0',bytes:f.bytes};};
  f.api=async(method,path,body)=>{
    f.calls.push({method,path,body});
    if(method==='GET'){
      if(path.endsWith('/nox-mcp'))return {full_name:repository,default_branch:'master'};
      if(path.endsWith('/workflows/contracts.yml'))return {id:42};
      if(path.endsWith('/runs/17'))return f.run;
      if(path.includes('/jobs?'))return {total_count:f.jobs.length,jobs:f.jobs};
      if(path.endsWith('/heads/master'))return {object:{sha:f.branch}};
      if(path.includes('/git/ref/tags/'))return f.tag;
      if(path.includes('/releases/tags/'))return f.existingRelease;
    }
    assert.ok(f.packaged,'Remote mutation preceded packaging');
    if(path.endsWith('/git/tags')){assert.equal(body.object,sha);assert.equal(body.type,'commit');return {sha:'annotated-tag'};}
    if(path.endsWith('/git/refs')){assert.equal(body.sha,'annotated-tag');return {};}
    if(path.endsWith('/releases')){assert.equal(body.draft,true);assert.equal(body.target_commitish,sha);return{id:9,upload_url:f.uploadURL??'https://uploads.github.com/upload{?name,label}'};}
    if(path.includes('/upload'))return {state:'uploaded',size:f.bytes.length};
    if(method==='PATCH'&&path.endsWith('/releases/9'))return {draft:body.draft,html_url:'https://github.com/mapherez/nox-mcp/releases/tag/v0.7.0'};
    throw Error(`Unexpected ${method} ${path}`);
  };
  return f;
}
const writes=f=>f.calls.filter(c=>c.method!=='GET');

test('real HTTP publication uses the approved SHA, uploads to a draft and publishes as its final operation',async t=>{
  const f=await fixture(t);
  const server=createServer(async(req,res)=>{
    try{
      assert.equal(req.headers.authorization,'Bearer fixture-token');
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
      const body=raw.length?(req.headers['content-type']==='application/gzip'?raw:JSON.parse(raw)):undefined;
      if(Buffer.isBuffer(body))assert.deepEqual(body,f.bytes);
      const data=await f.api(req.method,req.url,body);
      res.writeHead(data===null?404:200,{'content-type':'application/json'});res.end(JSON.stringify(data));
    }catch(error){res.writeHead(500);res.end(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;f.uploadURL=base+'/upload{?name,label}';
  const result=await publishRelease({...f,api:githubAPI('fixture-token',base)});
  assert.equal(result.draft,false);assert.equal(f.calls.at(-1).method,'PATCH');
  assert.deepEqual(writes(f).map(c=>c.method),['POST','POST','POST','POST','PATCH']);
  assert.equal(writes(f)[3].path,'/upload?name=nox-mcp.tgz');
});
test('rerunning only failed jobs preserves earlier approvals for the same SHA without executing tests again',async t=>{
  const f=await fixture(t),original=f.api;f.run.run_attempt=2;
  f.api=async(method,path,...rest)=>{
    if(path.includes('/attempts/1/jobs'))return{total_count:f.jobs.length,jobs:f.jobs.map((j,index)=>index===0?{...j,conclusion:'failure'}:j)};
    if(path.includes('/attempts/2/jobs'))return{total_count:1,jobs:[f.jobs[0]]};
    return original(method,path,...rest);
  };
  assert.equal((await publishRelease(f)).draft,false);
});
test('every unauthorized, failed, missing or mismatched CI gate rejects before packaging and writes',async t=>{
  const changes=[
    f=>f.run.conclusion='failure',f=>f.run.status='in_progress',f=>f.run.event='pull_request',
    f=>f.run.head_branch='feature',f=>f.run.head_repository.full_name='fork/nox-mcp',f=>f.run.repository.full_name='fork/nox-mcp',
    f=>f.run.head_sha='0'.repeat(40),f=>f.run.workflow_id=8,f=>f.run.name='Unrelated workflow',f=>f.run.path='other.yml',
    f=>f.jobs.pop(),f=>f.jobs[0]=f.jobs[1],f=>f.jobs[0].conclusion='skipped',f=>f.jobs[0].conclusion='cancelled',
    f=>f.jobs[0].status='in_progress',f=>f.jobs[0].head_sha='0'.repeat(40),f=>f.jobs[0].run_id=18,
    f=>f.branch='0'.repeat(40),f=>f.tag={existing:true},f=>f.existingRelease={draft:false},
  ];
  for(const[index,change]of changes.entries())await t.test(String(index),async t=>{
    const f=await fixture(t);change(f);await assert.rejects(publishRelease(f));assert.equal(f.packaged,false);assert.deepEqual(writes(f),[]);
  });
});
test('ordinary commits, inconsistent versions and a different checkout cannot publish',async t=>{
  const ordinary=await fixture(t,{intent:false});assert.deepEqual(await publishRelease(ordinary),{skipped:true});assert.deepEqual(ordinary.calls,[]);
  const mismatched=await fixture(t);await assert.rejects(publishRelease({...mismatched,sha:'0'.repeat(40)}),/Checkout differs/);
  const f=await fixture(t);await writeFile(resolve(f.root,'package.json'),JSON.stringify({name:'@nox/mcp',version:'0.8.0'}));
  await assert.rejects(publishRelease(f),/Unclean/);assert.deepEqual(writes(f),[]);
});
test('packaging failures, mutation and superseded commits cannot create tags or public releases',async t=>{
  for(const kind of ['failure','wrong-version','source-change','superseded','tag-race','release-race'])await t.test(kind,async t=>{
    const f=await fixture(t);f.packDistribution=async()=>{
      if(kind==='failure')throw Error('Build failed');
      if(kind==='source-change')await writeFile(resolve(f.root,'go.mod'),'unexpected');
      if(kind==='superseded')f.branch='0'.repeat(40);
      if(kind==='tag-race')f.tag={existing:true};
      if(kind==='release-race')f.existingRelease={draft:false};
      return{version:kind==='wrong-version'?'0.8.0':'0.7.0',bytes:f.bytes};
    };
    await assert.rejects(publishRelease(f));assert.deepEqual(writes(f),[]);
  });
});
test('an upload failure leaves a draft and never executes the publication operation',async t=>{
  const f=await fixture(t),original=f.api;
  f.api=async(...args)=>{if(args[1].includes('/upload'))throw Error('Upload failed');return original(...args);};
  await assert.rejects(publishRelease(f),/Upload failed/);assert.equal(writes(f).some(c=>c.method==='PATCH'),false);
});
test('only HTTP 404 means missing; authentication errors and unsafe upload origins fail closed',async t=>{
  const server=createServer((_,res)=>{res.writeHead(403);res.end('denied');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const api=githubAPI('fixture-token',`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(api('GET','/missing',undefined,{missing:true}),/HTTP 403/);
  await assert.rejects(api('POST','https://example.invalid/upload',Buffer.from('x'),{binary:true}),/Unexpected GitHub API origin/);
});
test('release markers are explicit, unambiguous and semantically versioned',()=>{
  assert.equal(releaseVersion('Normal master commit'),null);
  assert.equal(releaseVersion('chore: release v0.7.0-rc.1\n\nNoX-Release: 0.7.0-rc.1'),'0.7.0-rc.1');
  for(const text of ['chore: release v0.7.0\n\nNoX-Release: bad','Other subject\n\nNoX-Release: 0.7.0','chore: release v0.7.0\n\nNoX-Release: 0.7.0\nNoX-Release: 0.7.0'])assert.throws(()=>releaseVersion(text));
});
