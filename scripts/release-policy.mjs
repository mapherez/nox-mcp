import assert from 'node:assert/strict';
import {versionPattern} from './update-version.mjs';

export const workflowName='Supported / Required compatibility';
export const workflowPath='.github/workflows/contracts.yml';
// Fail closed if the required matrix changes without reviewing the release gate.
export const requiredJobs=[
  ...['ubuntu-latest','windows-latest'].map(os=>`Supported / Required conformance / ${os}`),
  ...['ubuntu-latest','windows-latest'].flatMap(os=>['minimum','latest'].flatMap(profile=>['rust','go','typescript'].map(language=>`Supported / Required consumer / ${language} / ${profile} / ${os}`))),
  'Supported / Required consumer / rust / latest / macos-latest',
  ...['26','node'].map(node=>`Supported / Required Node / ${node}`),
];
export function releaseVersion(message) {
  const markers=message.match(/^NoX-Release:.*$/gm)??[];
  if(!markers.length)return null; // An ordinary master commit is not a release.
  assert.equal(markers.length,1,'Ambiguous release intent');
  const version=markers[0].slice('NoX-Release: '.length);
  assert.ok(versionPattern.test(version),'Invalid release intent version');
  assert.equal(message.split(/\r?\n/)[0],`chore: release v${version}`,'Release subject and intent differ');
  return version;
}
export function validateRun(run,{repository,sha,runId,workflowId}) {
  assert.match(sha,/^[a-f0-9]{40}$/,'Invalid release SHA');
  assert.equal(run.id,runId,'Wrong workflow run');
  assert.equal(run.workflow_id,workflowId,'Wrong workflow identity');
  assert.equal(run.name,workflowName,'Wrong workflow name');
  assert.equal(run.path,workflowPath,'Wrong workflow path');
  assert.equal(run.head_sha,sha,'CI validated another SHA');
  assert.equal(run.head_branch,'master','Release requires master');
  assert.equal(run.head_repository?.full_name,repository,'Foreign head repository');
  assert.equal(run.repository?.full_name,repository,'Foreign workflow repository');
  assert.equal(run.event,'push','Only master pushes authorize publication');
  assert.equal(run.status,'completed','CI has not completed');
  assert.equal(run.conclusion,'success','CI was not approved');
  assert.ok(Number.isSafeInteger(run.run_attempt)&&run.run_attempt>0,'Invalid CI attempt');
}
export function validateJobs(jobs,{runId,sha}) {
  assert.equal(jobs.length,requiredJobs.length,'Missing or unexpected required jobs');
  assert.deepEqual(jobs.map(j=>j.name).sort(),[...requiredJobs].sort(),'Required job matrix differs');
  for(const job of jobs) {
    assert.equal(job.run_id,runId,'Job belongs to another run');
    assert.equal(job.head_sha,sha,'Job belongs to another SHA');
    assert.equal(job.status,'completed',`Incomplete job: ${job.name}`);
    assert.equal(job.conclusion,'success',`Unapproved job: ${job.name}`);
  }
}
