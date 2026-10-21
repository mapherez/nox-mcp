// Deliberately fails while upstream Go SSE framing is invalid. This diagnostic
// is not part of the supported/required workflow or release dependency graph.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {exerciseDiscoveryFixtures} from './discovery-wire.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temp=await mkdtemp(resolve(tmpdir(),'nox-investigating-sse-'));
try {
  console.log('Investigating / Future Support — Go SSE. A failure here diagnoses unsupported behavior; it is not a conformance pass.');
  const executable=resolve(temp,'go-sse'+(process.platform==='win32'?'.exe':''));
  execFileSync('go',['build','-mod=readonly','-o',executable,'./go/testdata/discovery-server'],{cwd:root,stdio:'inherit'});
  await exerciseDiscoveryFixtures([['go',executable,[]]],{suite:'investigating-go-sse'});
  console.log('Go SSE reproducer no longer fails. Review upstream version, supported matrix and all SSE regressions before promoting support.');
} finally {
  assert.equal(dirname(temp),resolve(tmpdir()));
  await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
