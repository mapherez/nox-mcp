// Runs from an installed tarball, never imports the SDK checkout.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {z} from 'zod';
import {createHttpHandler,McpError,DiscoveryCache,discoveryMeta} from '@nox/mcp';
import Ajv2020 from 'ajv/dist/2020.js';
import {toNodeHandler} from '@nox/mcp/node';
for(const responseMode of [undefined,'sse']){
 let forbiddenExecutions=0;
 const handler=createHttpHandler({appId:'consumer',name:'consumer',version:'0.5.0',...(responseMode&&{responseMode}),
  discovery:{serverId:'installed-consumer',resolveView:()=>({viewId:'authorized'})},
  tools:[
   {name:'echo',description:'Consumer regression',_meta:{package:true,cli:'echo'},inputSchema:z.object({value:z.string()}),outputSchema:z.object({value:z.string()}),execute:async input=>input},
   {name:'restricted',description:'Authorization regression',requiredScopes:['write'],inputSchema:z.object({}),outputSchema:z.object({value:z.string()}),execute:async()=>{forbiddenExecutions++;return {value:'must not run'}}},
   {name:'domain',description:'Domain failure',inputSchema:z.object({}),outputSchema:z.object({value:z.string()}),execute:async()=>{throw new McpError('CONFLICT','Visible domain error',false,{version:2})}},
  ]});
 const node=toNodeHandler(handler),server=createServer((req,res)=>void node(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');
 const url=`http://127.0.0.1:${server.address().port}/mcp`;let id=0;
 async function request(method,params={},modern=true){
  const body={jsonrpc:'2.0',id:++id,method,params:modern?{...params,_meta:{...discoveryMeta(),...params._meta}}:params};
  const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(modern&&{'mcp-protocol-version':'2026-07-28','mcp-method':method,...(method==='tools/call'&&{'mcp-name':params.name})})},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  const text=await response.text(),stream=response.headers.get('content-type')?.startsWith('text/event-stream');
  const reply=stream?text.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).filter(Boolean).map(line=>JSON.parse(line)).find(m=>m.id===body.id):JSON.parse(text);
  assert.equal(reply.id,body.id);assert.equal(reply.jsonrpc,'2.0');
  if(reply.error)throw Object.assign(Error(reply.error.message),reply.error);
  assert.equal(response.status,200);return reply.result;
 }
 try{
  for(const modern of [false,true]){
   await request(modern?'server/discover':'initialize',modern?{}:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'consumer',version:'0.5.0'}},modern);
   const listed=await request('tools/list',{},modern),echo=listed.tools.find(t=>t.name==='echo');assert.deepEqual(echo._meta,{package:true,cli:'echo'});
   const validators=new Map(listed.tools.map(tool=>[tool.name,new Ajv2020({strict:false}).compile(tool.outputSchema)]));
   for(const [name,args,code]of [['echo',{value:'installed tarball'},null],['restricted',{},'FORBIDDEN'],['domain',{},'CONFLICT']]){
    const result=await request('tools/call',{name,arguments:args},modern);
    // Strict client: every supplied structuredContent must match outputSchema.
    if(Object.hasOwn(result,'structuredContent'))assert.ok(validators.get(name)(result.structuredContent));
    if(code){assert.equal(result.isError,true);assert.equal(result.structuredContent,undefined);assert.equal(JSON.parse(result.content[0].text).code,code);}
    else{assert.deepEqual(result.structuredContent,args);assert.deepEqual(JSON.parse(result.content[0].text),args);}
   }
   assert.equal(forbiddenExecutions,0);
   if(modern){
    let downloads=0;const rpc=async(method,p)=>{const result=await request(method,p);if(method.endsWith('/definitions'))downloads+=result.definitions.length;return result};
    const cache=new DiscoveryCache(url,'credential-a');await cache.sync(rpc);assert.equal(downloads,3);await cache.sync(rpc);assert.equal(downloads,3);
    const definition=cache.definitions.get('echo');assert.deepEqual(definition.tool,echo);
    await assert.rejects(request('tools/call',{name:'echo',arguments:{value:'stale'},_meta:{'nox/discovery':{expectedFingerprint:'stale'}}}),/STALE_DEFINITION/);
   }
  }
 }finally{await handler.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
console.log('Installed tarball: legacy/modern JSON/SSE, metadata, strict output validation, auth/domain errors and incremental cache passed.');
