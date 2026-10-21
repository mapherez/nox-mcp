import assert from 'node:assert/strict';
import { readFile,writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createServer as httpServer } from 'node:http';
import { once } from 'node:events';
import { z } from 'zod';
import { McpServer,InMemoryTransport } from '@modelcontextprotocol/server';
import { installDiscovery } from '../dist/index.js';
import { DiscoveryService,DiscoveryCache,canonicalize,fingerprint,interpretCli,validateDiscovery,createHttpHandler,discoveryMeta,DISCOVERY_EXTENSION } from '../dist/index.js';
import { toNodeHandler } from '../dist/node.js';
const corpus=JSON.parse(await readFile(new URL('../../contracts/discovery-conformance.json',import.meta.url),'utf8'));
const view=()=>({viewId:'user-a:policy-1',definitions:[{tool:structuredClone(corpus.tool),cli:structuredClone(corpus.cli)}]});

test('shared discovery conformance: canonical bytes, hashes, descriptors and snapshots',async()=>{
 const report={jcs:[],cli:[],schemas:[]};
 for(const fixture of corpus.schemaCases){let valid=true;try{validateDiscovery(fixture.schema,fixture.data)}catch{valid=false};assert.equal(valid,fixture.valid);report.schemas.push(valid);}
 for(const fixture of corpus.jcs){const canonical=canonicalize(fixture.input);assert.equal(canonical,fixture.canonical);report.jcs.push({canonical,hash:fingerprint(fixture.input)});}
 for(const fixture of corpus.cliCases){try{const normalized=interpretCli(fixture.value);assert.ok(fixture.valid,fixture.name);report.cli.push(normalized);}catch(e){assert.equal(fixture.valid,false,fixture.name);report.cli.push({error:e.reason});}}
 const service=new DiscoveryService('test-installation'),current=view();report.initial=service.catalog(current);report.definitions=service.definitions(current,{catalog:report.initial.catalog,tools:report.initial.tools});
 const changed=structuredClone(current);changed.definitions[0].tool.description+=' Alterado.';changed.definitions.push({tool:{...structuredClone(corpus.tool),name:'new_tool'}});report.changed=service.catalog(changed);
 assert.notEqual(report.initial.catalog,report.changed.catalog);
 if(process.env.NOX_DISCOVERY_REPORT)await writeFile(process.env.NOX_DISCOVERY_REPORT,JSON.stringify(report));
});
test('JCS rejects invalid input; whitespace/key order do not change fingerprints',()=>{
 for(const input of [NaN,Infinity,undefined,{bad:undefined},'\ud800',new Date(),[,,]])assert.throws(()=>canonicalize(input));
 assert.equal(fingerprint({a:1,b:2}),fingerprint({b:2,a:1}));assert.notEqual(fingerprint({a:null}),fingerprint({}));
 assert.notEqual(fingerprint([1,2]),fingerprint([2,1]));
});
test('clearing an in-flight cache prevents a late commit and callers cannot mutate cache values',async()=>{
 const service=new DiscoveryService('srv'),current=view(),cache=new DiscoveryCache('origin','credential');
 let release,started;const entered=new Promise(resolve=>started=resolve),waiting=new Promise(resolve=>release=resolve);
 const sync=cache.sync(async(method,p)=>{if(method.endsWith('/catalog')){started();await waiting;return service.catalog(current,p)}return service.definitions(current,p)});
 await entered;cache.clear();release();await assert.rejects(sync,/CACHE_INVALIDATED/);assert.equal(cache.definitions.size,0);
 await cache.sync(async(method,p)=>method.endsWith('/catalog')?service.catalog(current,p):service.definitions(current,p));
 const copy=cache.definitions;copy.values().next().value.tool.name='tampered';assert.equal(cache.definitions.has('example_item_get'),true);assert.equal(cache.definitions.values().next().value.tool.name,'example_item_get');
});
test('cache downloads only changed definitions; removals, availability and auth contexts',async()=>{
 const service=new DiscoveryService('srv'),cache=new DiscoveryCache('stdio:trusted','credential-a');let current=view();let downloads=[];
 const request=async(method,params)=>{if(method.endsWith('/catalog'))return service.catalog(current,{...params,limit:1});downloads.push(...params.tools.map(t=>t.name));return service.definitions(current,params);};
 await cache.sync(request);assert.deepEqual(downloads,['example_item_get']);downloads=[];await cache.sync(request);assert.deepEqual(downloads,[]);
 current.definitions.push({tool:{...structuredClone(corpus.tool),name:'added'}});await cache.sync(request);assert.deepEqual(downloads,['added']);downloads=[];
 current.definitions[0].tool.description+=' changed';await cache.sync(request);assert.deepEqual(downloads,['example_item_get']);downloads=[];
 current.definitions[0].availability='unavailable';await cache.sync(request);assert.deepEqual(downloads,[]);assert.equal(cache.catalog.tools.find(t=>t.name==='example_item_get').availability,'unavailable');
 current.definitions.splice(1,1);await cache.sync(request);assert.equal(cache.definitions.has('added'),false);
 current.viewId='user-b:policy-1';await cache.sync(request);assert.deepEqual(downloads,['example_item_get']);
 current.definitions=[];current.viewId='user-b:revoked';await cache.sync(request);assert.equal(cache.definitions.size,0);
});
test('partial failures and stale snapshots leave the cache intact',async()=>{
 const service=new DiscoveryService('srv'),cache=new DiscoveryCache('origin','credential');let current=view();
 const request=async(method,p)=>method.endsWith('/catalog')?service.catalog(current,{...p,limit:1}):service.definitions(current,p);
 await cache.sync(request);const before=[...cache.definitions];current.definitions[0].tool.description+=' changed';
 await assert.rejects(cache.sync(async(method,p)=>{if(method.endsWith('/definitions'))throw Error('disconnected');return request(method,p);}));assert.deepEqual([...cache.definitions],before);
 await assert.rejects(cache.sync(async(method,p)=>{if(method.endsWith('/definitions')){current.viewId='revoked';return service.definitions(current,p);}return request(method,p);}),/STALE_CATALOG/);assert.deepEqual([...cache.definitions],before);
 current=view();current.definitions.push({tool:{...corpus.tool,name:'other'}});
 await assert.rejects(cache.sync(async(method,p)=>{const result=await request(method,p);if(p.cursor!==undefined)result.tools=[];return result;}));assert.deepEqual([...cache.definitions],before);
 await assert.rejects(cache.sync(async(method,p)=>{const result=await request(method,p);if(method.endsWith('/catalog')){result.tools=[];delete result.nextCursor;}return result;}),/INVALID_CATALOG/);assert.deepEqual([...cache.definitions],before);
});
test('hash integrity, authorization, stale execution guard and bounds',async()=>{
 const service=new DiscoveryService('srv'),current=view(),catalog=service.catalog(current),reference=catalog.tools[0];
 assert.doesNotThrow(()=>service.guard(current,reference.name,{[DISCOVERY_EXTENSION]:{expectedFingerprint:reference.fingerprint}}));
 assert.throws(()=>service.guard(current,reference.name,{[DISCOVERY_EXTENSION]:{expectedFingerprint:'wrong'}}),/STALE_DEFINITION/);
 assert.throws(()=>service.guard({...current,definitions:[]},reference.name),/FORBIDDEN/);
 assert.throws(()=>service.definitions({...current,viewId:'revoked',definitions:[]},{catalog:catalog.catalog,tools:[reference]}),/STALE_CATALOG/);
 const cache=new DiscoveryCache('origin','partition');await assert.rejects(cache.sync(async(method,p)=>{if(method.endsWith('/catalog'))return catalog;const result=service.definitions(current,p);result.definitions[0].tool.description='tampered';return result;}),/INVALID_FINGERPRINT/);assert.equal(cache.definitions.size,0);
 assert.throws(()=>service.catalog(current,{cursor:1}),/INVALID_DISCOVERY/);assert.throws(()=>service.catalog(current,{unknown:1}),/INVALID_DISCOVERY/);
 assert.throws(()=>service.definitions(current,{catalog:catalog.catalog,tools:Array(65).fill(reference)}));
 assert.throws(()=>new DiscoveryService('srv',0,10).catalog(current),/PAYLOAD_LIMIT/);
});
test('real HTTP: legacy/modern tools/list, extension negotiation, selective fetch and execution guard',async t=>{
 let allowed=true,unavailable=false;
 const handler=createHttpHandler({appId:'test',name:'test',version:'0.5.0',tools:[{name:'echo',description:'Echo',_meta:{cli:'echo',custom:{keep:true}},inputSchema:z.object({value:z.string()}),outputSchema:z.object({value:z.string()}),execute:async x=>x}],discovery:{serverId:'http-test',descriptors:{echo:{version:'1.0'}},resolveView:()=>({viewId:allowed?'allowed':'revoked',visible:allowed?['echo']:[],unavailable:unavailable?['echo']:[]})}});
 const node=toNodeHandler(handler),server=httpServer((req,res)=>void node(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{await handler.close();server.closeAllConnections();await new Promise(r=>server.close(r));});const url=`http://127.0.0.1:${server.address().port}/mcp`;
 async function request(method,params={},modern=true){const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json',...(modern?{'mcp-protocol-version':'2026-07-28','mcp-method':method,...(method==='tools/call'?{'mcp-name':params.name}:{})}:{})},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params:{...params,...(modern?{_meta:{...discoveryMeta(),...params._meta}}:{})}})});const body=await response.json();if(body.error)throw Object.assign(Error(body.error.message),{code:body.error.code,data:body.error.data,status:response.status});return body.result;}
 const standard=await request('tools/list');assert.equal(standard.tools[0]._meta.custom.keep,true);
 const legacy=await request('tools/list',{},false);assert.deepEqual(legacy.tools,standard.tools);
 const discovery=await request('server/discover');assert.deepEqual(discovery.capabilities.extensions[DISCOVERY_EXTENSION].versions,['1.0']);
 const catalog=await request('nox/tools/catalog');assert.equal(catalog.tools.length,1);
 for(const method of ['nox/tools/catalog','nox/tools/definitions'])await assert.rejects(request(method,{_meta:{'io.modelcontextprotocol/clientCapabilities':{}}}),e=>{assert.equal(e.code,-32021);assert.equal(e.status,400);assert.deepEqual(e.data,{requiredCapabilities:{extensions:{[DISCOVERY_EXTENSION]:{version:'1.0'}}}});return true;});
 await assert.rejects(request('nox/tools/catalog',{unexpected:true}),e=>{assert.equal(e.code,-32602);return true;});
 const definitions=await request('nox/tools/definitions',{catalog:catalog.catalog,tools:catalog.tools});assert.deepEqual(definitions.definitions[0].tool,standard.tools[0]);
 const call={name:'echo',arguments:{value:'ok'},_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:catalog.tools[0].fingerprint}}};assert.ok(await request('tools/call',call));
 await assert.rejects(request('tools/call',{...call,_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:'stale'}}}),/STALE_DEFINITION/);
 unavailable=true;await assert.rejects(request('tools/call',call),/UNAVAILABLE/);unavailable=false;
 allowed=false;assert.equal((await request('tools/list')).tools.length,0);await assert.rejects(request('tools/call',call),/FORBIDDEN/);await assert.rejects(request('nox/tools/definitions',{catalog:catalog.catalog,tools:catalog.tools}),/STALE_CATALOG/);
});
test('SDK registrations remain authoritative: icons, updates, rename, disable and remove',async t=>{
 const server=new McpServer({name:'test',version:'0.5.0'});
 installDiscovery(server,{serverId:'registry',resolveView:()=>({viewId:'authorized'})});
 let executions=0;
 const handle=server.registerTool('first',{title:'First',icons:[{src:'https://example.invalid/icon.svg'}],inputSchema:z.object({}),outputSchema:z.object({ok:z.boolean()}),_meta:{cli:'first',custom:true}},async()=>{executions++;return {structuredContent:{ok:true},content:[]}});
 const[client,transport]=InMemoryTransport.createLinkedPair();await server.connect(transport);await client.start();t.after(()=>server.close());let id=0;
 async function rpc(method,params={}){const requestId=++id;const response=new Promise((resolve,reject)=>{client.onmessage=message=>{if(message.id===requestId){if(message.error)reject(Error(JSON.stringify(message.error)));else resolve(message.result)}}});await client.send({jsonrpc:'2.0',id:requestId,method,params:{...params,_meta:{...discoveryMeta(),...params._meta}}});return response;}
 const cache=new DiscoveryCache('registry','credential');await cache.sync(rpc);const first=cache.definitions.get('first');assert.deepEqual(first.tool.icons,[{src:'https://example.invalid/icon.svg'}]);
 handle.update({title:'Updated'});await assert.rejects(rpc('tools/call',{name:'first',arguments:{},_meta:{[DISCOVERY_EXTENSION]:{expectedFingerprint:first.fingerprint}}}),/STALE_DEFINITION/);assert.equal(executions,0);await cache.sync(rpc);assert.equal(cache.definitions.get('first').tool.title,'Updated');
 handle.update({name:'renamed'});await cache.sync(rpc);assert.equal(cache.definitions.has('first'),false);assert.equal(cache.definitions.has('renamed'),true);await rpc('tools/call',{name:'renamed',arguments:{}});assert.equal(executions,1);
 handle.disable();await cache.sync(rpc);assert.equal(cache.definitions.size,0);handle.enable();await cache.sync(rpc);assert.equal(cache.definitions.size,1);handle.remove();await cache.sync(rpc);assert.equal(cache.definitions.size,0);
});
