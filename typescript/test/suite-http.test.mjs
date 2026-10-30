import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {z} from 'zod';
import {createSuiteHttpHandler,suitePolicy,discoveryMeta} from '../dist/index.js';
const corpus=JSON.parse(await readFile(new URL('../../contracts/suite-conformance.json',import.meta.url)));
const crypto=corpus.crypto;
function endpoint(options={}){
 let calls=0,active=true,now=crypto.options.nowMs;
 const contexts=[];const schema=z.object({write:z.boolean().optional()});
 const tools=['inspect','write','dynamic','unclassified'].map(name=>({name,description:name,inputSchema:schema,outputSchema:schema,_meta:{'nox/authorization':suitePolicy(['nox:inspect'])},execute:async(input,context)=>{calls++;contexts.push(context);return input;}}));
 const handler=createSuiteHttpHandler({appId:'example',name:'example',version:'1',tools,verification:()=>({...crypto.options,keys:new Map([[crypto.publicKey.kid,crypto.publicKey]])}),clock:()=>now,
  policies:{inspect:suitePolicy(['nox:inspect']),write:suitePolicy(['nox:inspect','nox:write']),dynamic:suitePolicy(['nox:inspect'],true)},
  additionalScopes:(_name,input)=>input.write?['nox:write']:[],isActive:()=>active,
  discovery:{serverId:'example',resolveView:()=>({viewId:'local-policy'})},...options,
 });
 async function post(method,params={},token=crypto.userToken,{modern=true,headers={},batch}={}){
  const message={jsonrpc:'2.0',id:1,method,params:modern?{...params,_meta:discoveryMeta()}:params};
  const response=await handler.fetch(new Request('https://inventory.example.com/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',authorization:'Bearer '+token,
   ...(modern&&{'mcp-protocol-version':'2026-07-28','mcp-method':method,...(method==='tools/call'&&{'mcp-name':params.name})}),
   'nox-request-id':'7e36db7f-c74e-4f74-ad55-f26b4f220965','nox-deadline-at':new Date(Date.now()+20000).toISOString(),'nox-timeout-ms':'20000',...headers},body:JSON.stringify(batch??message)}));
  const text=await response.text();return {status:response.status,body:text?JSON.parse(text):null};
 }
 return {handler,post,contexts,calls:()=>calls,revoke:()=>{active=false},expire:()=>{now+=300000}};
}
test('Suite HTTP verifies identity, filters listing, enforces additive policies and carries controls',async t=>{
 const e=endpoint();t.after(()=>e.handler.close());
 for(const modern of [true,false]){
  const listed=await e.post('tools/list',{},crypto.userToken,{modern});assert.equal(listed.status,200);assert.deepEqual(listed.body.result.tools.map(t=>t.name).sort(),['dynamic','inspect']);
  const allowed=await e.post('tools/call',{name:'inspect',arguments:{}},crypto.userToken,{modern});assert.equal(allowed.body.result.isError,undefined);
  for(const name of ['write','unclassified']){const denied=await e.post('tools/call',{name,arguments:{}},crypto.userToken,{modern});assert.ok(denied.body.error||denied.body.result.isError);}
  const dynamic=await e.post('tools/call',{name:'dynamic',arguments:{write:true}},crypto.userToken,{modern});assert.equal(JSON.parse(dynamic.body.result.content[0].text).code,'FORBIDDEN');
 }
 assert.equal((await e.post('tools/list',{},crypto.userToken,{headers:{authorization:'bearer '+crypto.userToken}})).status,200);
 assert.equal(e.calls(),2);assert.equal(e.contexts[0].userId,'user-1');assert.equal(e.contexts[0].requestId,'7e36db7f-c74e-4f74-ad55-f26b4f220965');
 assert.ok(Date.parse(e.contexts[0].deadlineAt)<=Date.now()+15000);
 assert.equal((await e.post('tools/list',{},'forged')).status,401);
 e.revoke();assert.equal((await e.post('tools/list')).status,401);assert.equal(e.calls(),2);
});
test('probe credentials cannot enumerate, call, obtain definitions or smuggle a call through a batch',async t=>{
 const e=endpoint();t.after(()=>e.handler.close());
 for(const method of ['tools/list','tools/call','nox/tools/catalog','nox/tools/definitions','subscriptions/listen'])assert.equal((await e.post(method,{},crypto.probeToken)).status,403,method);
 const initialized=await e.post('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'probe',version:'1'}},crypto.probeToken,{modern:false});assert.equal(initialized.status,200);
 const batch=[{jsonrpc:'2.0',id:1,method:'ping',params:{}},{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'inspect',arguments:{}}}];assert.equal((await e.post('ping',{},crypto.probeToken,{modern:false,batch})).status,403);assert.equal(e.calls(),0);
 e.expire();assert.equal((await e.post('ping',{},crypto.probeToken)).status,401);
});
test('Suite transport rejects missing controls and stale deadlines before dispatch',async t=>{
 const e=endpoint();t.after(()=>e.handler.close());
 assert.equal((await e.post('tools/call',{name:'inspect',arguments:{}},crypto.userToken,{headers:{'nox-request-id':''}})).status,400);
 assert.equal((await e.post('tools/call',{name:'inspect',arguments:{}},crypto.userToken,{headers:{'nox-deadline-at':new Date(Date.now()-1).toISOString()}})).status,408);assert.equal(e.calls(),0);
});
