import assert from 'node:assert/strict';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DiscoveryCache,discoveryMeta,DISCOVERY_EXTENSION } from '../typescript/dist/index.js';
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
 const fixtures=[['typescript',process.execPath,[resolve(root,'scripts/fixtures/discovery-server.mjs')]],['go',go,[]],['rust',resolve(root,'rust/target/debug/examples/discovery_fixture'+exe),[]]];
 for(const[language,command,args]of fixtures)for(const transport of ['stdio','http']){
  const child=spawn(command,[...args,...(transport==='http'?['--http']:[])],{cwd:root,stdio:['pipe','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);const lines=createInterface({input:child.stdout});let id=0;const pending=new Map();let urlResolve,urlReject;const url=new Promise((resolve,reject)=>{urlResolve=resolve;urlReject=reject;});
  lines.on('line',line=>{if(line.startsWith('http://'))urlResolve(line);else{let message;try{message=JSON.parse(line)}catch{return};const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);entry.resolve(message);}}});child.on('error',e=>{urlReject(e);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(e)}});child.on('exit',code=>{if(code){const e=Error(`${language} exited ${code}: ${stderr}`);urlReject(e);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(e)}}});
  let endpoint;if(transport==='http')endpoint=await Promise.race([url,new Promise((_,reject)=>setTimeout(()=>reject(Error('HTTP fixture startup timed out: '+stderr)),10000).unref())]);
  async function rpc(method,params={},modern=true){const request={jsonrpc:'2.0',id:++id,method,params:{...params,...(modern?{_meta:{...discoveryMeta(),...params._meta}}:{})}};let message;
   if(transport==='stdio'){message=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request.id);reject(Error(`${language}/${method} timed out: ${stderr}`))},5000);pending.set(request.id,{resolve,reject,timer});child.stdin.write(JSON.stringify(request)+'\n');});}
   else{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(modern?{'mcp-protocol-version':'2026-07-28','mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{})}:{})},body:JSON.stringify(request),signal:AbortSignal.timeout(5000)});const text=await response.text();try{message=JSON.parse(text)}catch{throw Error(`${language} HTTP ${response.status}: ${text}`)}}
   if(message.error)throw Error(JSON.stringify(message.error));if(message.result?.isError)throw Error(JSON.stringify(message.result));return message.result;
  }
  try{
   const discover=await rpc('server/discover');assert.deepEqual(discover.capabilities.extensions[DISCOVERY_EXTENSION].versions,['1.0']);
   const standard=await rpc('tools/list',{_meta:{'io.modelcontextprotocol/clientCapabilities':{}}});assert.equal(standard.tools[0]._meta.cli,'item show');assert.deepEqual(standard.tools[0]._meta.custom.preserve,[1,null,'á']);
   await assert.rejects(rpc('nox/tools/catalog',{_meta:{'io.modelcontextprotocol/clientCapabilities':{}}}),/EXTENSION_NOT_NEGOTIATED/);
   await assert.rejects(rpc('nox/tools/catalog',{unexpected:true}),/INVALID_DISCOVERY|[Ii]nvalid/);
   let downloaded=0;const request=async(method,p)=>{const result=await rpc(method,p);if(method.endsWith('/definitions'))downloaded+=result.definitions.length;return result;};const cache=new DiscoveryCache(`${language}:${transport}`,'credential-a');await cache.sync(request);assert.equal(downloaded,1);await cache.sync(request);assert.equal(downloaded,1);
   const definition=[...cache.definitions.values()][0];assert.deepEqual(definition.tool,standard.tools[0]);assert.equal(definition.cli.version,'1.0');
   const call={name:definition.tool.name,arguments:{id:'42'},_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:definition.fingerprint}}};assert.ok(await rpc('tools/call',call));await assert.rejects(rpc('tools/call',{...call,_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:'old'}}}),/STALE_DEFINITION/);
   await assert.rejects(rpc('tools/call',{...call,_meta:{...call._meta,'test/policy':'unavailable'}}),/UNAVAILABLE/);
   const hidden=await rpc('tools/list',{_meta:{'test/policy':'revoked'}});assert.deepEqual(hidden.tools,[]);await assert.rejects(rpc('nox/tools/definitions',{catalog:cache.catalog.catalog,tools:cache.catalog.tools.map(({name,fingerprint})=>({name,fingerprint})),_meta:{'test/policy':'revoked'}}),/STALE_CATALOG/);
   console.log(`${language}: real ${transport} discovery, cache, standard listing, negotiation, permissions and guarded execution passed.`);
  }catch(e){throw Error(`${language}/${transport}: ${e.stack}\n${stderr}`)}finally{lines.close();child.stdin.end();child.kill();for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('closed'))}}
 }
}finally{assert.equal(dirname(temp),resolve(tmpdir()));await rm(temp,{recursive:true,force:true});}
