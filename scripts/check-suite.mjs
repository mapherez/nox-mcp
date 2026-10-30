import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await mkdtemp(resolve(tmpdir(),'nox-suite-conformance-'));
try{
 const runners=[['typescript',process.execPath,['--test','typescript/test/suite.test.mjs']],['go','go',['test','-count=1','-mod=readonly','./go','-run','^TestSharedSuiteConformance$']],['rust','cargo',['test','--locked','--manifest-path','rust/Cargo.toml','--test','suite','shared_suite_conformance']]];
 const reports=[];
 for(const[language,command,args]of runners){const path=resolve(temporary,language+'.json');execFileSync(command,args,{cwd:root,stdio:'inherit',env:{...process.env,NOX_SUITE_REPORT:path}});reports.push(JSON.parse(await readFile(path,'utf8')));}
 for(const report of reports.slice(1))assert.deepEqual(report,reports[0],'Suite behavior diverged across languages');
 console.log(`Suite documents, signed authorization, private views, aggregation, state and deadlines agree across TypeScript, Go and Rust (${reports[0].documents.length} document cases, ${reports[0].crypto.length} signature cases).`);
}finally{await rm(temporary,{recursive:true,force:true});}
