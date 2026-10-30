// Explicit maintenance tool, never an install hook or SDK issuer. Private keys
// exist only during fixture generation; committed tokens/public keys are test data.
import {createHash,createHmac,generateKeyPairSync,sign} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
const file=new URL('../../contracts/suite-conformance.json',import.meta.url);
const corpus=JSON.parse(await readFile(file,'utf8'));
const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const key={...publicKey.export({format:'jwk'}),kid:'fixture-es256',alg:'ES256',use:'sig'};
const wrong=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const base=corpus.examples['delegation-claims'],probe=corpus.examples['probe-claims'];
const nowMs=base.iat*1000+10000;
const options={issuer:base.iss,audience:base.aud,productId:base.nox.productId,associationId:base.nox.associationId,gatewayServiceId:base.act.sub,registrationRevision:base.nox.registrationRevision,serviceCredentialRevision:base.nox.serviceCredentialRevision,nowMs};
const b64=v=>Buffer.from(v).toString('base64url');
const compact=(claims,{header={},rawHeader,rawPayload,key:signer=privateKey,der=false}={})=>{
 const h=b64(rawHeader??JSON.stringify({alg:'ES256',typ:'nox-delegation+jwt',kid:key.kid,...header}));
 const p=b64(rawPayload??JSON.stringify(claims));const signed=h+'.'+p;
 return signed+'.'+sign('sha256',Buffer.from(signed),{key:signer,dsaEncoding:der?'der':'ieee-p1363'}).toString('base64url');
};
const context=claims=>({contractVersion:'1.0',...(claims.act?{userId:claims.sub,keyId:claims.nox.keyId,authRevision:claims.nox.authRevision,gatewayServiceId:claims.act.sub,scopes:claims.scope.split(' ')}:{serviceId:claims.sub,purpose:'mcp-probe'}),serviceCredentialRevision:claims.nox.serviceCredentialRevision,productId:claims.nox.productId,registrationRevision:claims.nox.registrationRevision,associationId:claims.nox.associationId});
const cases=[];
function add(id,claims=base,config={},overrides={},error='INVALID_DELEGATION',keyVariant){
 const token=compact(claims,config);
 const expected=error?{error}:{kind:config.header?.typ==='nox-service+jwt'?'probe':'user',context:context(claims),expiresAtMs:claims.exp*1000-5000};
 cases.push({id,token,options:overrides,...(keyVariant?{keyVariant}:{}),expect:expected});return token;
}
const userToken=add('valid-user',base,{}, {},null);
const admin=structuredClone(base);admin.scope='nox:inspect nox:write nox:sensitive-read';add('valid-admin',admin,{}, {},null);
const probeToken=add('valid-probe',probe,{header:{typ:'nox-service+jwt'}},{kind:'probe'},null);
const extra=structuredClone(base);extra.custom={preserve:[null,false]};add('signed-unknown-optional-claims',extra,{}, {},null);
const otherUser=structuredClone(base);otherUser.sub='user-2';otherUser.nox.keyId='key-2';add('valid-other-user',otherUser,{}, {},null);
const renewed=structuredClone(base);renewed.nox.authRevision='auth-2';add('valid-renewed-authorization',renewed,{}, {},null);
const later=structuredClone(base);later.iat+=295;later.nbf+=295;later.exp+=295;later.jti='later-grant';add('valid-later-authorization',later,{}, {nowMs:later.iat*1000+1000},null);
add('wrong-algorithm',base,{header:{alg:'HS256'}});
add('wrong-type',base,{header:{typ:'JWT'}});
add('unknown-key',base,{header:{kid:'unknown'}});
for(const [name,value]of Object.entries({crit:['custom'],b64:false,jku:'https://attacker.invalid/jwks',x5u:'https://attacker.invalid/key',jwk:key,x5c:[]}))add('forbidden-header-'+name,base,{header:{[name]:value}});
add('wrong-signing-key',base,{key:wrong.privateKey});add('der-signature-is-not-jws',base,{der:true});
add('duplicate-header',base,{rawHeader:'{"alg":"ES256","alg":"ES256","typ":"nox-delegation+jwt","kid":"fixture-es256"}'});
add('duplicate-claims',base,{rawPayload:JSON.stringify(base).replace('"sub":"user-1"','"sub":"user-1","sub":"user-1"')});
add('invalid-unicode-payload',base,{rawPayload:JSON.stringify(base).replace('"sub":"user-1"','"sub":"\\ud800"')});
for(const [field,value]of Object.entries({iss:'urn:other',aud:'https://other.example.com/mcp',sub:'',scope:'nox:write',iat:base.exp,nbf:base.exp,exp:base.iat+301,jti:''})){
 const claim=structuredClone(base);claim[field]=value;add('invalid-claim-'+field,claim);
}
for(const field of ['productId','associationId','registrationRevision','serviceCredentialRevision']){const claim=structuredClone(base);claim.nox[field]='different';add('wrong-binding-'+field,claim);}
const actor=structuredClone(base);actor.act.sub='other-gateway';add('wrong-actor',actor);
add('unknown-private-key-material',base,{}, {},'INVALID_DELEGATION','private');
add('invalid-curve-point',base,{}, {},'INVALID_DELEGATION','point');
add('incorrect-key-purpose',base,{}, {},'INVALID_DELEGATION','purpose');
add('before-expiry-margin',base,{}, {nowMs:base.exp*1000-5001},null);
add('at-expiry-margin',base,{}, {nowMs:base.exp*1000-5000});
add('expired',base,{}, {nowMs:base.exp*1000});
add('issued-too-far-ahead',base,{}, {nowMs:base.iat*1000-5001});
add('issued-within-clock-uncertainty',base,{}, {nowMs:base.iat*1000-4999},null);
add('user-cannot-be-probe',base,{}, {kind:'probe'});
add('probe-cannot-be-user',probe,{header:{typ:'nox-service+jwt'}},{kind:'user'});
const elevated=structuredClone(probe);elevated.scope='nox:inspect';add('probe-cannot-have-user-scopes',elevated,{header:{typ:'nox-service+jwt'}});
const actorProbe=structuredClone(probe);actorProbe.act={sub:'user-1'};add('probe-cannot-have-user-actor',actorProbe,{header:{typ:'nox-service+jwt'}});
for(const [id,token]of [['bad-signature',userToken.slice(0,-8)+'AAAAAAAA'],['padding',userToken+'='],['extra-segment',userToken+'.x'],['missing-segment','x.y'],['oversized','x'.repeat(16385)]])cases.push({id,token,options:{},expect:{error:'INVALID_DELEGATION'}});
const stable=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(stable).join(',')+']':'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+stable(v[k])).join(',')+'}';
const secret=Buffer.from(Array.from({length:32},(_,i)=>i));const binding=corpus.examples['pairing-binding'];
const proof=createHmac('sha256',secret).update(stable(binding)).digest('base64url');
const aliasCases=[];
for(const [productId,toolName]of [['example-inventory','record_list'],['example-calendar','record_list'],['p','x'.repeat(61)],['p','x'.repeat(62)],['a'.repeat(64),'b'.repeat(64)],['example-art','🎨'.repeat(64)]]){
 const readable=productId+'__'+toolName;const expect=readable.length<=64&&/^[A-Za-z0-9_.-]+$/.test(readable)?readable:'_'+createHash('sha256').update(JSON.stringify([productId,toolName])).digest('base64url');aliasCases.push({productId,toolName,expect});
}
corpus.examples['signing-key']=key;
corpus.schemaCases=corpus.schemaCases.filter(v=>v.schema!=='signing-key');
corpus.schemaCases.push({id:'signing-key-valid',schema:'signing-key',data:key,valid:true},{id:'signing-key-private',schema:'signing-key',data:{...key,d:'A'.repeat(43)},error:'INVALID_INTEGRATION'});
for(const field of ['kty','crv','x','y']){const data={...key};delete data[field];corpus.schemaCases.push({id:'signing-key-missing-'+field,schema:'signing-key',data,error:'INVALID_INTEGRATION'});}
corpus.crypto={options,publicKey:key,userToken,probeToken,cases,methods:[{kind:'user',method:'tools/call'},{kind:'probe',method:'ping'},{kind:'probe',method:'server/discover'},{kind:'probe',method:'tools/call',error:'FORBIDDEN'},{kind:'probe',method:'tools/list',error:'FORBIDDEN'},{kind:'probe',method:'nox/tools/catalog',error:'FORBIDDEN'}],pairing:{secret:secret.toString('base64url'),binding,proof,partition:createHmac('sha256',secret).update('nox:credential-partition:1.0\0').update('fictional-api-key').digest('base64url')}};
corpus.aliases=aliasCases;
await writeFile(file,JSON.stringify(corpus,null,2)+'\n');
console.log(`Wrote ${cases.length} signed verification fixtures, method guards, HMAC and alias vectors. No private signing key was stored.`);
