// Test-only host: test/policy stands in for a host-resolved, live authorization context.
import { readFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServerFromManifest,McpError } from '../../typescript/dist/index.js';
import { serveStdio,toNodeHandler } from '../../typescript/dist/node.js';
import { createMcpHandler,MissingRequiredClientCapabilityError,UnsupportedProtocolVersionError,ProtocolError } from '@modelcontextprotocol/server';
import { z } from 'zod';
const c=JSON.parse(await readFile(new URL('../../contracts/discovery-conformance.json',import.meta.url),'utf8'));
let executions=0;
function server(){const sdk=createServerFromManifest({appId:'fixture',name:'fixture',version:'0.5.0',manifest:{schemaVersion:1,protocolVersion:'2.0',tools:[c.tool]},bindings:{[c.tool.name]:{execute:async input=>{executions++;if(input.id==='domain-error')throw new McpError('CONFLICT','Visible domain error');return {name:input.id}}}},discovery:{serverId:'fixture',descriptors:{[c.tool.name]:c.cli},resolveView:ctx=>{const policy=ctx.mcpReq._meta?.['test/policy']??'allowed';return {viewId:String(policy),visible:policy==='revoked'?[]:undefined,unavailable:policy==='unavailable'?[c.tool.name]:[]};}}});
 sdk.server.setRequestHandler('test/executions',{params:z.object({}).passthrough()},async()=>({count:executions}));
 // Test-only late failure: committing progress must not lose the terminal error.
 sdk.server.setRequestHandler('test/stream-capability',{params:z.object({code:z.number().optional()}).passthrough()},async(params,ctx)=>{
  await ctx.mcpReq.notify({method:'notifications/progress',params:{progressToken:'late',progress:1}});
  if(params.code===-32022)throw new UnsupportedProtocolVersionError({requested:'2099-01-01',supported:['2026-07-28']});
  if(params.code===-32602||params.code===-32601)throw new ProtocolError(params.code,'Test late protocol error');
  throw new MissingRequiredClientCapabilityError({requiredCapabilities:{extensions:{'nox/discovery':{version:'1.0'}}}});
 });
 return sdk;
}
if(process.argv.includes('--http')){
 const handler=createMcpHandler(()=>server(),{responseMode:process.argv.includes('--sse')?'sse':'json'}),node=toNodeHandler(handler);
 const http=httpServer((req,res)=>void node(req,res));http.listen(0,'127.0.0.1',()=>process.stdout.write(`http://127.0.0.1:${http.address().port}/mcp\n`));
}else serveStdio(()=>server());
