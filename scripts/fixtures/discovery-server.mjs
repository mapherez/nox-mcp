// Test-only host: test/policy stands in for a host-resolved, live authorization context.
import { readFile } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { createServerFromManifest } from '../../typescript/dist/index.js';
import { serveStdio,toNodeHandler } from '../../typescript/dist/node.js';
import { createMcpHandler,MissingRequiredClientCapabilityError } from '@modelcontextprotocol/server';
import { z } from 'zod';
const c=JSON.parse(await readFile(new URL('../../contracts/discovery-conformance.json',import.meta.url),'utf8'));
function server(){const sdk=createServerFromManifest({appId:'fixture',name:'fixture',version:'0.5.0',manifest:{schemaVersion:1,protocolVersion:'2.0',tools:[c.tool]},bindings:{[c.tool.name]:{execute:async input=>({name:input.id})}},discovery:{serverId:'fixture',descriptors:{[c.tool.name]:c.cli},resolveView:ctx=>{const policy=ctx.mcpReq._meta?.['test/policy']??'allowed';return {viewId:String(policy),visible:policy==='revoked'?[]:undefined,unavailable:policy==='unavailable'?[c.tool.name]:[]};}}});
 // Test-only late failure: committing progress must not lose the terminal error.
 sdk.server.setRequestHandler('test/stream-capability',{params:z.object({}).passthrough()},async(_,ctx)=>{
  await ctx.mcpReq.notify({method:'notifications/progress',params:{progressToken:'late',progress:1}});
  throw new MissingRequiredClientCapabilityError({requiredCapabilities:{extensions:{'nox/discovery':{version:'1.0'}}}});
 });
 return sdk;
}
if(process.argv.includes('--http')){
 const handler=createMcpHandler(()=>server(),{responseMode:process.argv.includes('--sse')?'sse':'json'}),node=toNodeHandler(handler);
 const http=httpServer((req,res)=>void node(req,res));http.listen(0,'127.0.0.1',()=>process.stdout.write(`http://127.0.0.1:${http.address().port}/mcp\n`));
}else serveStdio(()=>server());
