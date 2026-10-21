import assert from 'node:assert/strict';
import { execFileSync,spawn } from 'node:child_process';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { DiscoveryCache,discoveryMeta,DISCOVERY_EXTENSION } from '../typescript/dist/index.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=await mkdtemp(resolve(tmpdir(),'nox-discovery-'));
const corpus=JSON.parse(await readFile(resolve(root,'contracts/discovery-conformance.json'),'utf8'));
const requiredCapabilities={extensions:{[DISCOVERY_EXTENSION]:{version:'1.0'}}};
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
 for(const[language,command,args]of fixtures)for(const transport of ['stdio','http','http-sse','stdio-legacy','http-legacy']){
  const http=transport.startsWith('http'),legacy=transport.endsWith('legacy');
  const child=spawn(command,[...args,...(http?['--http']:[]),...(transport==='http-sse'?['--sse']:[])],{cwd:root,stdio:['pipe','pipe','pipe']});const closed=new Promise(resolve=>child.once('close',resolve));let stderr='';child.stderr.on('data',b=>stderr+=b);const lines=createInterface({input:child.stdout});let id=0;const pending=new Map();let urlResolve,urlReject;const url=new Promise((resolve,reject)=>{urlResolve=resolve;urlReject=reject;});url.catch(()=>{});
  lines.on('line',line=>{if(line.startsWith('http://'))urlResolve(line);else{let message;try{message=JSON.parse(line)}catch{return};const entry=pending.get(message.id);if(entry){pending.delete(message.id);clearTimeout(entry.timer);entry.resolve(message);}}});child.on('error',e=>{urlReject(e);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(e)}});child.on('exit',code=>{if(code){const e=Error(`${language} exited ${code}: ${stderr}`);urlReject(e);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(e)}}});
  let endpoint;if(http)endpoint=await Promise.race([url,new Promise((_,reject)=>setTimeout(()=>reject(Error('HTTP fixture startup timed out: '+stderr)),10000).unref())]);
  async function rpc(method,params={},modern=!legacy,raw=false){const request={jsonrpc:'2.0',id:++id,method,params:{...params,...(modern?{_meta:{...discoveryMeta(),...params._meta}}:{})}};let message,status,contentType,frames=[],unframed=[];
   if(!http){message=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(request.id);reject(Error(`${language}/${method} timed out: ${stderr}`))},5000);pending.set(request.id,{resolve,reject,timer});child.stdin.write(JSON.stringify(request)+'\n');});}
   else{const response=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(modern?{'mcp-protocol-version':request.params._meta['io.modelcontextprotocol/protocolVersion'],'mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{})}:{})},body:JSON.stringify(request),signal:AbortSignal.timeout(5000)});status=response.status;contentType=response.headers.get('content-type');const text=await response.text();try{
    if(contentType?.includes('text/event-stream')){
     frames=text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean).map(data=>JSON.parse(data));message=frames.find(frame=>frame.id===request.id);
     // Diagnose, never mistake unframed JSON for a valid SSE event.
     unframed=text.split(/\r?\n/).filter(line=>line.startsWith('{')).map(data=>JSON.parse(data));
     if(raw&&method==='test/stream-capability'&&!message)message=unframed.find(frame=>frame.id===request.id);
    }
    else message=JSON.parse(text);
   }catch{throw Error(`${language} HTTP ${response.status}: ${text}`)}}
   assert.ok(message,`${language}/${transport}/${method}: HTTP ${status}, frames ${JSON.stringify(frames)}`);assert.equal(message.jsonrpc,'2.0');assert.equal(message.id,request.id);
   if(raw)return {message,status,contentType,frames,unframed};
   if(message.error)throw Error(JSON.stringify(message.error));if(message.result?.isError)throw Error(JSON.stringify(message.result));return message.result;
  }
  try{
   if(legacy){
    const init=await rpc('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'legacy-fixture',version:'0.5.0'}});assert.equal(init.protocolVersion,'2025-11-25');
    if(!http)child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})+'\n');
    const listed=await rpc('tools/list');assert.equal(listed.tools[0]._meta.cli,'item show');assert.deepEqual(listed.tools[0]._meta.custom,corpus.tool._meta.custom);
    const called=await rpc('tools/call',{name:listed.tools[0].name,arguments:{id:'legacy'}});assert.equal(called.isError??false,false);assert.deepEqual(called.structuredContent,{name:'legacy'});
    for(const method of ['nox/tools/catalog','nox/tools/definitions']){const rejected=await rpc(method,{},false,true);assert.equal(rejected.message.error?.code,-32602);assert.equal(rejected.message.error.data.reason,'EXTENSION_NOT_NEGOTIATED');}
    console.log(`${language}: real ${transport} initialize, standard tools/list, metadata and tools/call passed.`);continue;
   }
   const discover=await rpc('server/discover');assert.deepEqual(discover.capabilities.extensions[DISCOVERY_EXTENSION].versions,['1.0']);
   const standard=await rpc('tools/list',{_meta:{'io.modelcontextprotocol/clientCapabilities':{}}});assert.equal(standard.tools[0]._meta.cli,'item show');assert.deepEqual(standard.tools[0]._meta.custom.preserve,[1,null,'á']);
   const initial=await rpc('nox/tools/catalog');
   for(const fixture of corpus.negotiationCases)for(const method of ['nox/tools/catalog','nox/tools/definitions']){
    const params=method.endsWith('/catalog')?{}:{catalog:initial.catalog,tools:initial.tools};
    if(fixture.invalidParams)params.unexpected=true;
    params._meta={'io.modelcontextprotocol/clientCapabilities':fixture.omitCapabilities?undefined:fixture.capabilities,...(fixture.protocol?{'io.modelcontextprotocol/protocolVersion':fixture.protocol}:{})};
    const {message,status,contentType,frames}=await rpc(method,params,true,true);
    if(fixture.code===null){assert.ok(message.result,`${fixture.id}: ${JSON.stringify(message)}`);assert.equal(message.error,undefined)}else{
     assert.equal(message.error?.code,fixture.code,`${language}/${transport}/${method}/${fixture.id}: ${JSON.stringify(message)}`);assert.equal(message.result,undefined);
     if(fixture.code===-32021)assert.deepEqual(message.error.data,{requiredCapabilities});
     if(fixture.code===-32022){assert.equal(message.error.data.requested,fixture.protocol);assert.ok(message.error.data.supported.includes('2026-07-28'));}
    }
    if(http){
     const expected=fixture.httpStatusBySDK?.[language]??fixture.httpStatus;
     // A successful or ordinary in-band response may already use SSE/200.
     const streaming=contentType?.includes('text/event-stream');
     assert.equal(status,streaming?200:expected,`${language}/${transport}/${fixture.id}`);
     // Some SDK transports commit SSE/200 before dispatching the handler.
     // JSON rejections must be 400; a committed stream carries a terminal error.
     if(fixture.code===-32021){if(streaming)assert.equal(frames.at(-1).id,message.id);else{assert.equal(status,400);assert.match(contentType,/application\/json/);}}
     assert.match(contentType,/application\/json|text\/event-stream/);
    }
   }
   if(transport==='http-sse'){
    const late=await rpc('test/stream-capability',{_meta:{progressToken:'late'}},true,true);
    assert.equal(late.status,200);assert.match(late.contentType,/text\/event-stream/);
    assert.equal(late.message.error?.code,-32021);assert.deepEqual(late.message.error.data,{requiredCapabilities});
    assert.equal(late.frames[0].method,'notifications/progress');assert.equal(late.message.result,undefined);
    if(language==='go'&&late.unframed.length){
     assert.equal(late.unframed.length,1);assert.equal(late.frames.length,1);
     console.warn('KNOWN SDK LIMITATION (Go 1.8.0): a late -32021 after SSE progress is unframed JSON, not a terminal SSE event. NoX negotiation rejects before streaming; see DISCOVERY.md.');
    }else{assert.deepEqual(late.unframed,[]);assert.equal(late.frames.at(-1).id,late.message.id);}
   }
   await assert.rejects(rpc('nox/tools/catalog',{unexpected:true}),/INVALID_DISCOVERY|[Ii]nvalid/);
   let downloaded=0;const request=async(method,p)=>{const result=await rpc(method,p);if(method.endsWith('/definitions'))downloaded+=result.definitions.length;return result;};const cache=new DiscoveryCache(`${language}:${transport}`,'credential-a');await cache.sync(request);assert.equal(downloaded,1);await cache.sync(request);assert.equal(downloaded,1);
   const definition=[...cache.definitions.values()][0];assert.deepEqual(definition.tool,standard.tools[0]);assert.equal(definition.cli.version,'1.0');
   const call={name:definition.tool.name,arguments:{id:'42'},_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:definition.fingerprint}}};assert.ok(await rpc('tools/call',call));await assert.rejects(rpc('tools/call',{...call,_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:'old'}}}),/STALE_DEFINITION/);
   await assert.rejects(rpc('tools/call',{...call,_meta:{...call._meta,'test/policy':'unavailable'}}),/UNAVAILABLE/);
   const hidden=await rpc('tools/list',{_meta:{'test/policy':'revoked'}});assert.deepEqual(hidden.tools,[]);await assert.rejects(rpc('nox/tools/definitions',{catalog:cache.catalog.catalog,tools:cache.catalog.tools.map(({name,fingerprint})=>({name,fingerprint})),_meta:{'test/policy':'revoked'}}),/STALE_CATALOG/);
   console.log(`${language}: real ${transport} discovery, cache, standard listing, negotiation, permissions and guarded execution passed.`);
  }catch(e){throw Error(`${language}/${transport}: ${e.stack}\n${stderr}`)}finally{lines.close();child.stdin.end();child.kill();await closed;for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(Error('closed'))}}
 }
}finally{assert.equal(dirname(temp),resolve(tmpdir()));await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
