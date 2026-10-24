import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {exerciseDiscoveryFixtures} from './discovery-wire.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=await mkdtemp(resolve(tmpdir(),'nox-discovery-'));
const exe=process.platform==='win32'?'.exe':'';
const run=(command,args,env={})=>execFileSync(command,args,{cwd:root,env:{...process.env,...env},stdio:'inherit'});
try{
 const reports=[];
 for(const[language,command,args]of [
 ['typescript',process.execPath,['--test','typescript/test/discovery.test.mjs']],
 ['go','go',['test','-count=1','-mod=readonly','./go','-run','TestSharedDiscoveryConformance|TestDiscovery']],
 ['rust','cargo',['test','--locked','--manifest-path','rust/Cargo.toml','--test','discovery']]
 ]){const path=resolve(temp,language+'.json');run(command,args,{NOX_DISCOVERY_REPORT:path});reports.push(JSON.parse(await readFile(path,'utf8')));}
 for(const report of reports.slice(1))assert.deepEqual(report,reports[0],'NoX discovery behavior differs across languages');
 console.log('Identical JCS bytes, fingerprints, CLI interpretations, catalogs and definitions in all three languages.');
 const go=resolve(temp,'discovery-go'+exe);run('go',['build','-mod=readonly','-o',go,'./go/testdata/discovery-server']);run('cargo',['build','--locked','--manifest-path','rust/Cargo.toml','--example','discovery_fixture']);
 const metadata=JSON.parse(execFileSync('cargo',['metadata','--locked','--format-version','1','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024}));
 const mcp=metadata.packages.filter(pkg=>pkg.name==='rmcp');assert.equal(mcp.length,1,'Expected one resolved rmcp dependency');
 const fixtures=[['typescript',process.execPath,[resolve(root,'scripts/fixtures/discovery-server.mjs')]],['go',go,[]],['rust',resolve(root,'rust/target/debug/examples/discovery_fixture'+exe),[],{sdkVersion:mcp[0].version}]];
 await exerciseDiscoveryFixtures(fixtures);
}finally{assert.equal(dirname(temp),resolve(tmpdir()));await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
