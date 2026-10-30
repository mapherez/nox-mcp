import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {test} from 'node:test';
import {loadSuiteDocument,normalizeSuiteOrigin,normalizeSuitePath,parseSuiteJson,suiteToolAlias} from '../dist/suite.js';
import {verifySuiteToken,requireSuiteMethod,createSuitePairingProof,verifySuitePairingProof,suiteCredentialPartition} from '../dist/suite-auth.js';
import {composeSuiteGateway,selectSuiteRoute,suiteAuthorizationViewKey} from '../dist/suite-gateway.js';
import {acceptSuiteObservation,reduceSuiteRegistry,suiteObservationState,suiteRequestBudget} from '../dist/suite-state.js';
import {SuiteAuthorizationCache} from '../dist/suite-cache.js';
const corpus=JSON.parse(await readFile(new URL('../../contracts/suite-conformance.json',import.meta.url)));

test('shared Suite conformance: complete documents and portable addresses',async()=>{
 const report={documents:[],origins:[],paths:[],raw:[]};
 for(const example of corpus.schemaCases){
  let actual;try{actual=loadSuiteDocument(example.schema,example.data);}catch(error){actual={error:error.code};}
  assert.deepEqual(actual,example.error?{error:example.error}:example.data,example.id);report.documents.push(actual);
 }
 for(const [name,fn]of [['origins',normalizeSuiteOrigin],['paths',normalizeSuitePath]])for(const example of corpus[name]){
  let actual;try{actual=fn(example.input);}catch(error){actual={error:error.code};}assert.deepEqual(actual,example.error?{error:example.error}:example.expect,example.input);report[name].push(actual);
 }
 for(const example of corpus.rawCases){let actual;try{actual=parseSuiteJson(example.input);}catch(error){actual={error:error.code};}assert.deepEqual(actual,{error:example.error});report.raw.push(actual);}
 report.observations=corpus.observationCases.map(example=>{let actual;try{actual=acceptSuiteObservation(example.binding,example.input,example.receivedAtMs,example.previous);assert.equal(suiteObservationState(actual.envelope,example.receivedAtMs+45000),'unknown');}catch(error){actual={error:error.code};}if(example.error)assert.deepEqual(actual,{error:example.error},example.id);return actual;});
 report.registry=corpus.registryCases.map(example=>{let actual;try{actual=reduceSuiteRegistry(example.snapshot,example.page,example.expectedCursor);assert.equal(actual.products.length,example.products,example.id);}catch(error){actual={error:error.code};}if(example.error)assert.deepEqual(actual,{error:example.error},example.id);return actual;});
 report.budgets=corpus.budgetCases.map(e=>{let actual;try{actual=suiteRequestBudget(e.controls,e.nowMs,e.localMaxMs,e.clockUncertaintyMs);}catch(error){actual={error:error.code};}assert.deepEqual(actual,e.error?{error:e.error}:e.expect,e.id);return actual;});
 report.viewKeys=['valid-user','valid-probe','valid-other-user','valid-renewed-authorization'].map(id=>{const example=corpus.crypto.cases.find(e=>e.id===id);return suiteAuthorizationViewKey(verifySuiteToken(example.token,{...corpus.crypto.options,keys:new Map([[corpus.crypto.publicKey.kid,corpus.crypto.publicKey]])}),corpus.crypto.pairing.partition,'1.0');});assert.equal(new Set(report.viewKeys).size,4);
 report.crypto=[];
 for(const example of corpus.crypto.cases){
  const key=structuredClone(corpus.crypto.publicKey);
  if(example.keyVariant==='private')key.d='A'.repeat(43);
  if(example.keyVariant==='point')key.y='A'.repeat(43);
  if(example.keyVariant==='purpose')key.use='enc';
  let actual;try{const identity=verifySuiteToken(example.token,{...corpus.crypto.options,...example.options,keys:new Map([[key.kid,key]])});actual={kind:identity.kind,context:identity.context(),expiresAtMs:identity.expiresAtMs};}catch(error){actual={error:error.code};}
  assert.deepEqual(actual,example.expect,example.id);report.crypto.push(actual);
 }
 report.methods=[];
 for(const example of corpus.crypto.methods){
  const key=corpus.crypto.publicKey;const identity=verifySuiteToken(corpus.crypto[example.kind+'Token'],{...corpus.crypto.options,keys:new Map([[key.kid,key]])});
  let actual=true;try{requireSuiteMethod(identity,example.method,corpus.crypto.options.nowMs);}catch(error){actual={error:error.code};}
  assert.deepEqual(actual,example.error?{error:example.error}:true);report.methods.push(actual);
 }
 const pair=corpus.crypto.pairing;const secret=Buffer.from(pair.secret,'base64url');
 const proof=createSuitePairingProof(secret,pair.binding);assert.equal(proof,pair.proof);assert.equal(verifySuitePairingProof(secret,pair.binding,proof),true);assert.equal(verifySuitePairingProof(secret,{...pair.binding,productId:'different'},proof),false);
 assert.equal(suiteCredentialPartition('fictional-api-key',secret),pair.partition);report.pairing={proof,partition:pair.partition};
 report.aliases=corpus.aliases.map(example=>{const actual=suiteToolAlias(example.productId,example.toolName);assert.equal(actual,example.expect);return actual;});
 report.gateway=[];
 for(const example of corpus.gatewayCases){
  const before=structuredClone(example.input);let actual;
  try{actual=composeSuiteGateway(example.input);}catch(error){actual={error:error.code};}
  if(example.error)assert.deepEqual(actual,{error:example.error},example.id);
  else{assert.equal(actual.contractVersion,'1.0',example.id);assert.equal(new Set(actual.routes.map(r=>r.alias)).size,actual.routes.length);assert.ok(actual.routes.every(r=>r.alias.length<=64));
   assert.deepEqual(actual.diagnostics.map(d=>d.code).sort(),[...(example.diagnostics??[])].sort(),example.id);
   for(const route of actual.routes){const definition=actual.definitions.find(d=>d.tool.name===route.alias);assert.equal(definition.tool._meta['nox/gateway'].sourceFingerprint,route.sourceFingerprint);assert.equal(definition.tool._meta.custom.literal,'record_preview');
    if(route.availability==='available'){assert.equal(selectSuiteRoute(actual,route.alias,route.fingerprint).toolName,route.toolName);assert.throws(()=>selectSuiteRoute(actual,route.alias,'A'.repeat(43)),{code:'STALE_DEFINITION'});}else assert.throws(()=>selectSuiteRoute(actual,route.alias),{code:'UNAVAILABLE'});
   }
   const deletion=actual.definitions.find(d=>d.tool.name==='example-inventory__record_delete');if(deletion?.cli){assert.equal(deletion.cli.preview.tool,'example-inventory__record_preview');assert.equal(deletion.cli.parameters['/id'].options.tool,'example-inventory__record_list');}
  }
  assert.deepEqual(example.input,before,'composition mutated its sources');report.gateway.push(actual);
 }
 if(process.env.NOX_SUITE_REPORT)await writeFile(process.env.NOX_SUITE_REPORT,JSON.stringify(report));
});
test('authorization cache coalesces renewals, isolates credentials, expires and rejects late invalidated commits',async()=>{
 const c=corpus.crypto;let now=c.options.nowMs;let monotonic=0;const keys=new Map([[c.publicKey.kid,c.publicKey]]);
 const identity=id=>{const fixture=id?c.cases.find(v=>v.id===id):null;return verifySuiteToken(fixture?.token??c.userToken,{...c.options,...fixture?.options,keys});};
 const partition={credentialPartition:c.pairing.partition,issuer:c.options.issuer,audience:c.options.audience,gatewayServiceId:c.options.gatewayServiceId,serviceCredentialRevision:c.options.serviceCredentialRevision,productId:c.options.productId,associationId:c.options.associationId,registrationRevision:c.options.registrationRevision};
 const cache=new SuiteAuthorizationCache({now:()=>now,monotonic:()=>monotonic});let loads=0;let release;const waiting=new Promise(resolve=>release=resolve);
 const requests=Array.from({length:20},()=>cache.refresh(partition,async()=>{loads++;await waiting;return identity();}));await Promise.resolve();assert.equal(loads,1);release();await Promise.all(requests);assert.equal(cache.stats.entries,1);
 const other={...partition,credentialPartition:suiteCredentialPartition('different-key',Buffer.from(c.pairing.secret,'base64url'))};await cache.refresh(other,async()=>identity('valid-other-user'));assert.equal(cache.get(partition).context().userId,'user-1');assert.equal(cache.get(other).context().userId,'user-2');
 cache.invalidate({keyId:'key-1'});assert.equal(cache.get(partition),undefined);assert.equal(cache.get(other).context().userId,'user-2');
 let resolveLate;const late=cache.refresh(partition,()=>new Promise(resolve=>resolveLate=resolve));await Promise.resolve();cache.invalidate({userId:'user-1'});const fresh=await cache.refresh(partition,async()=>identity('valid-renewed-authorization'));resolveLate(identity());await assert.rejects(late,{code:'AUTHORIZATION_INVALIDATED'});assert.equal(cache.get(partition).context().authRevision,'auth-2');
 now=fresh.expiresAtMs;assert.equal(cache.get(partition),undefined);assert.equal(cache.get(other),undefined);
 const later=identity('valid-later-authorization');await cache.refresh(partition,async()=>later);assert.equal(cache.stats.entries,1);
 now-=10000;assert.throws(()=>cache.get(partition),{code:'AUTHORIZATION_INVALIDATED'});assert.equal(cache.stats.entries,0);
});
test('cache bounds include obsolete pending renewals, and event extensions are inert',async()=>{
 const c=corpus.crypto;const partition={credentialPartition:c.pairing.partition,issuer:c.options.issuer,audience:c.options.audience,gatewayServiceId:c.options.gatewayServiceId,serviceCredentialRevision:c.options.serviceCredentialRevision,productId:c.options.productId,associationId:c.options.associationId,registrationRevision:c.options.registrationRevision};
 const cache=new SuiteAuthorizationCache({maxEntries:1,now:()=>c.options.nowMs});let release;const pending=cache.refresh(partition,()=>new Promise(resolve=>release=resolve));await Promise.resolve();cache.applyEvent({eventId:'revoke',type:'authorization.invalidated',occurredAt:'2026-10-29T12:00:00Z',data:{keyId:'key-1',optionalExplanation:'inert'}});
 assert.throws(()=>cache.refresh(partition,async()=>{throw Error('must not load')}),{code:'CACHE_LIMIT'});const keys=new Map([[c.publicKey.kid,c.publicKey]]);release(verifySuiteToken(c.userToken,{...c.options,keys}));await assert.rejects(pending,{code:'AUTHORIZATION_INVALIDATED'});assert.equal(cache.stats.pending,0);
});
test('verified identities cannot be forged by JSON, mutated via context, or serialized as tokens',()=>{
 const key=corpus.crypto.publicKey;const identity=verifySuiteToken(corpus.crypto.userToken,{...corpus.crypto.options,keys:new Map([[key.kid,key]])});
 assert.throws(()=>requireSuiteMethod({kind:'user',context:()=>({scopes:['nox:write']})},'tools/call',corpus.crypto.options.nowMs),{code:'INVALID_DELEGATION'});
 const context=identity.context();context.scopes.push('nox:write');assert.deepEqual(identity.context().scopes,['nox:inspect']);
 assert.ok(!JSON.stringify(identity).includes(corpus.crypto.userToken));
 assert.throws(()=>requireSuiteMethod(identity,'tools/call',identity.expiresAtMs),{code:'INVALID_DELEGATION'});
});
test('Suite loaders bound JSON depth and bytes without mutating objects',()=>{
 const original=corpus.examples['product-declaration'];const loaded=loadSuiteDocument('product-declaration',original);loaded.displayName='Changed';assert.notEqual(loaded.displayName,original.displayName);
 assert.throws(()=>loadSuiteDocument('product-declaration',original,8));
 let nested={};for(let i=0;i<65;i++)nested={nested};assert.throws(()=>parseSuiteJson(JSON.stringify(nested)));
 assert.throws(()=>loadSuiteDocument('product-declaration',{...original,custom:undefined}));
 assert.throws(()=>parseSuiteJson('{"a":1,"\\u0061":2}'));
 assert.throws(()=>parseSuiteJson(new Uint8Array([0xff])));
});
