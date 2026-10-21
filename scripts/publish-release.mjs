import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateVersion} from './update-version.mjs';
import {releaseVersion,validateJobs,validateRun} from './release-policy.mjs';

export function githubAPI(token,base='https://api.github.com') {
  return async(method,path,body,{missing=false,binary=false}={})=>{
    const target=new URL(path,base);
    const allowed=new Set([new URL(base).origin,'https://uploads.github.com']);
    assert.ok(allowed.has(target.origin),'Unexpected GitHub API origin');
    const response=await fetch(target,{method,redirect:'error',headers:{
      authorization:`Bearer ${token}`,accept:'application/vnd.github+json',
      'x-github-api-version':'2026-03-10',
      ...(body===undefined?{}:{'content-type':binary?'application/gzip':'application/json'}),
    },body:body===undefined?undefined:binary?body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
    if(missing&&response.status===404)return null;
    if(!response.ok)throw Error(`GitHub ${method} ${target.pathname}: HTTP ${response.status}`);
    return response.status===204?null:response.json();
  };
}

async function pack(root) {
  const temp=await mkdtemp(resolve(tmpdir(),'nox-release-pack-'));
  try {
    // No tests/prepack hook: the mandatory suite already approved this SHA.
    const env={...process.env}; delete env.GITHUB_TOKEN; delete env.GH_TOKEN;
    const npm=(...args)=>execFileSync('npm',args,{cwd:root,env,encoding:'utf8',stdio:['ignore','pipe','inherit']});
    npm('ci','--ignore-scripts','--no-audit','--no-fund');
    npm('run','build');
    const result=JSON.parse(npm('pack','--ignore-scripts','--json','--pack-destination',temp));
    const records=Array.isArray(result)?result:Object.values(result);
    assert.equal(records.length,1,'Unexpected package count');
    const record=records[0];
    assert.equal(record.name,'@nox/mcp','Unexpected package');
    assert.equal(record.filename,`nox-mcp-${record.version}.tgz`,'Unexpected package filename');
    return {version:record.version,bytes:await readFile(resolve(temp,record.filename))};
  } finally {
    assert.equal(dirname(temp),resolve(tmpdir())); await rm(temp,{recursive:true,force:true});
  }
}

export async function publishRelease({root,repository,runId,sha,api,packDistribution=pack}) {
  assert.match(repository,/^[\w.-]+\/[\w.-]+$/,'Invalid repository');
  assert.ok(Number.isSafeInteger(runId)&&runId>0,'Invalid run ID');
  const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  assert.equal(git('rev-parse','HEAD'),sha,'Checkout differs from approved SHA');
  assert.equal(git('status','--porcelain'),'','Unclean release checkout');
  const version=releaseVersion(git('log','-1','--format=%B'));
  if(version===null)return {skipped:true};
  const tag=`v${version}`;
  const versions=await validateVersion(root,version);
  assert.ok(versions.files.every(file=>file.versions.every(value=>value===version)),'Release versions differ');
  const prefix=`/repos/${repository}`;
  const info=await api('GET',prefix);
  assert.equal(info.full_name,repository); assert.equal(info.default_branch,'master','Unexpected default branch');
  const workflow=await api('GET',prefix+'/actions/workflows/contracts.yml');
  const run=await api('GET',prefix+`/actions/runs/${runId}`);
  validateRun(run,{repository,sha,runId,workflowId:workflow.id});
  // Native "rerun failed jobs" must retain successful jobs from earlier
  // attempts of the same SHA. Later attempts replace earlier observations.
  const latest=new Map();
  for(let attempt=1;attempt<=run.run_attempt;attempt++) {
    const page=await api('GET',prefix+`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
    assert.equal(page.total_count,page.jobs.length,'Truncated job list');
    const names=new Set();
    for(const job of page.jobs) {
      assert.equal(job.run_id,runId); assert.equal(job.head_sha,sha);
      assert.ok(!names.has(job.name),'Duplicate job in CI attempt'); names.add(job.name);
      latest.set(job.name,job);
    }
  }
  validateJobs([...latest.values()],{runId,sha});
  async function checkAvailable() {
    const branch=await api('GET',prefix+'/git/ref/heads/master');
    assert.equal(branch.object.sha,sha,'Release commit was superseded on master');
    assert.equal(await api('GET',prefix+`/git/ref/tags/${tag}`,undefined,{missing:true}),null,'Release tag already exists');
    assert.equal(await api('GET',prefix+`/releases/tags/${tag}`,undefined,{missing:true}),null,'Release already exists');
  }
  await checkAvailable();
  const distribution=await packDistribution(root);
  assert.equal(distribution.version,version,'Package differs from approved version');
  assert.ok(Buffer.isBuffer(distribution.bytes)&&distribution.bytes.length>0,'Empty package');
  assert.equal(git('rev-parse','HEAD'),sha,'Checkout changed during packaging');
  assert.equal(git('status','--porcelain'),'','Packaging changed source files');
  await checkAvailable();
  const annotated=await api('POST',prefix+'/git/tags',{tag,message:`Release ${tag}\nValidated CI: ${run.html_url}\nSHA: ${sha}`,object:sha,type:'commit'});
  await api('POST',prefix+'/git/refs',{ref:`refs/tags/${tag}`,sha:annotated.sha});
  const draft=await api('POST',prefix+'/releases',{tag_name:tag,target_commitish:sha,name:tag,draft:true,prerelease:version.includes('-'),generate_release_notes:true});
  const upload=new URL(draft.upload_url.replace(/\{.*\}$/,'')); upload.searchParams.set('name','nox-mcp.tgz');
  const asset=await api('POST',upload.href,distribution.bytes,{binary:true});
  assert.equal(asset.state,'uploaded','Release asset is incomplete');
  assert.equal(asset.size,distribution.bytes.length,'Release asset size differs');
  // Publication is the last API operation. Failures never overwrite/delete
  // existing tags/releases; an incomplete attempt requires explicit review.
  return api('PATCH',prefix+`/releases/${draft.id}`,{draft:false});
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.env.GITHUB_ACTIONS,'true','Publisher runs only in GitHub Actions');
    assert.equal(process.env.GITHUB_EVENT_NAME,'workflow_run','Publisher requires workflow_run');
    assert.equal(process.env.GITHUB_REPOSITORY,'mapherez/nox-mcp','Unexpected publishing repository');
    assert.ok(process.env.GITHUB_TOKEN,'Missing GitHub token');
    const event=JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8'));
    await publishRelease({root:resolve(dirname(fileURLToPath(import.meta.url)),'..'),repository:process.env.GITHUB_REPOSITORY,
      runId:event.workflow_run.id,sha:event.workflow_run.head_sha,api:githubAPI(process.env.GITHUB_TOKEN)});
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
