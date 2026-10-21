import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DiscoveryService,DiscoveryCache,discoveryMeta } from '../typescript/dist/index.js';
const c=JSON.parse(await readFile(new URL('../contracts/discovery-conformance.json',import.meta.url),'utf8'));
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
const exchange=(method,params,result)=>bytes({jsonrpc:'2.0',id:1,method,params})+bytes({jsonrpc:'2.0',id:1,result});
const rows=[];
for(const count of [10,100,1000]){
 const definitions=Array.from({length:count},(_,i)=>{
  const tool=structuredClone(c.tool);tool.name=`example_item_${String(i).padStart(4,'0')}`;tool._meta.cli=`item command${i}`;
  // Published, realistic-sized schemas; identical data is used on both sides.
  for(let n=0;n<12;n++)tool.inputSchema.properties[`option${n}`]={type:'string',description:`Optional parameter ${n} for the item operation.`,maxLength:256};
  return {tool,...(i%4===0?{cli:structuredClone(c.cli)}:{})};
 });
 const view={viewId:'authorized-user:policy-1',definitions},service=new DiscoveryService('benchmark-installation'),cache=new DiscoveryCache('benchmark','credential-a');
 let transferred=0,downloaded=0;
 const request=async(method,params)=>{const result=method.endsWith('/catalog')?service.catalog(view,params):service.definitions(view,params);transferred+=exchange(method,params,result);if(result.definitions)downloaded+=result.definitions.length;return result;};
 const conventional=()=>exchange('tools/list',{_meta:{...discoveryMeta(),'io.modelcontextprotocol/clientCapabilities':{}}},{resultType:'complete',tools:view.definitions.map(d=>d.tool)});
 const baseline=conventional();await cache.sync(request);const cold=transferred;assert.equal(downloaded,count);
 transferred=0;downloaded=0;await cache.sync(request);const unchanged=transferred;assert.equal(downloaded,0);
 view.definitions[0].tool.description+=' Updated definition.';transferred=0;downloaded=0;await cache.sync(request);const oneChanged=transferred;assert.equal(downloaded,1);
 view.definitions.pop();transferred=0;downloaded=0;await cache.sync(request);const oneRemoved=transferred;assert.equal(downloaded,0);assert.equal(cache.definitions.size,count-1);
 assert.ok(oneChanged<baseline*.3);rows.push({tools:count,conventional:baseline,incrementalCold:cold,unchanged,oneChanged,oneRemoved,reductionOneChanged:`${(100*(1-oneChanged/baseline)).toFixed(1)}%`});
}
console.table(rows);
console.log('UTF-8 bytes, minified JSON-RPC requests + responses, no compression. Synthetic catalogs; schemas are identical in both paths. Standard cache is assumed expired/invalidated. A still-fresh standard cache can also transfer zero bytes.');
