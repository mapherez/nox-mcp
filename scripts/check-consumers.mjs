// Independent native applications: no SDK lockfile is copied into a consumer.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp,mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exerciseDiscoveryFixtures} from './discovery-wire.mjs';
import {consumerOptions} from './consumer-options.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const {minimum,language,profile}=consumerOptions();
console.log(`Supported / Required consumer: language=${language}, profile=${profile}`);
const temp=await mkdtemp(resolve(tmpdir(),'nox-independent-'));
const run=(cmd,args,cwd,env={})=>execFileSync(cmd,args,{cwd,env:{...process.env,...env},stdio:'inherit'});
const output=(cmd,args,cwd,env={})=>execFileSync(cmd,args,{cwd,env:{...process.env,...env},stdio:['ignore','pipe','pipe'],encoding:'utf8',maxBuffer:16*1024*1024});
const rustManifest=await readFile(resolve(root,'rust/Cargo.toml'),'utf8');
// Full semantic floors, read from the actual manifest; no second version list.
const direct={};
for(const line of rustManifest.split(/\r?\n/).slice(rustManifest.split(/\r?\n/).indexOf('[dependencies]')+1)){
 if(line.startsWith('['))break;
 const match=line.match(/^([\w-]+) = (?:\{ version = )?"([\d.]+)"/);
 if(match)direct[match[1]]=match[2].split('.').concat(['0','0']).slice(0,3).join('.');
}
try{
 if(language==='all'||language==='go'){
  const lib=resolve(temp,'go-sdk'),consumer=resolve(temp,'go-consumer');await mkdir(lib);await mkdir(consumer);
  for(const file of ['go.mod','go.sum','go'])await cp(resolve(root,file),resolve(lib,file),{recursive:true});
  const gomod=await readFile(resolve(lib,'go.mod'),'utf8'),version=gomod.match(/^go (.+)$/m)[1];
  await writeFile(resolve(consumer,'go.mod'),`module example.invalid/nox-consumer\ngo ${version}\nrequire github.com/mapherez/nox-mcp v0.0.0\nreplace github.com/mapherez/nox-mcp => ${JSON.stringify(lib.replaceAll('\\','/'))}\n`);
  await cp(resolve(root,'scripts/consumer-go_test.txt'),resolve(consumer,'consumer_test.go'));
  const env={GOTOOLCHAIN:process.env.GOTOOLCHAIN??'local'};
  run('go',['mod','tidy'],consumer,env);
  if(!minimum){
   const modules=[...gomod.matchAll(/^\s*(github\.com\/\S+) (v\S+)$/gm)].map(m=>m[1]);
   run('go',['get',...modules.map(m=>m+'@latest')],consumer,env);
   run('go',['mod','tidy'],consumer,env);
  }
  console.log('Independent Go graph:\n'+output('go',['list','-m','all'],consumer,env));
  run('go',['test','-count=1','-mod=readonly','./...'],consumer,env);
  run('go',['vet','./...'],consumer,env);
  await mkdir(resolve(consumer,'cmd/fixture'),{recursive:true});
  await cp(resolve(root,'go/testdata/discovery-server/main.go'),resolve(consumer,'cmd/fixture/main.go'));
  const executable=resolve(temp,'go-consumer-fixture'+(process.platform==='win32'?'.exe':''));
  run('go',['build','-mod=readonly','-o',executable,'./cmd/fixture'],consumer,env);
  await exerciseDiscoveryFixtures([['go',executable,[]]]);
 }
 if(language==='all'||language==='rust'){
  // A local Git snapshot includes this reviewed working tree, not the old tag.
  // Consumers use git+rev and path independently; no changes to the real .git.
  const git=resolve(temp,'git-sdk');await mkdir(git);
  await cp(resolve(root,'rust'),resolve(git,'rust'),{recursive:true,filter:p=>!p.split(/[\\/]/).some(s=>s==='target'||s==='Cargo.lock')});
  run('git',['init','-q'],git);run('git',['-c','core.autocrlf=false','add','.'],git);
  run('git',['-c','user.name=NoX consumer test','-c','user.email=consumer@example.invalid','-c','commit.gpgsign=false','commit','-qm','Test SDK working tree'],git);
  const revision=output('git',['rev-parse','HEAD'],git).trim();
  const env={CARGO_TARGET_DIR:resolve(root,'rust/target/independent',minimum?'minimum':'latest'),CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS:'fallback'};
  for(const source of ['git','path']){
   const app=resolve(temp,'rust-'+source);await mkdir(resolve(app,'src'),{recursive:true});
   const dependency=source==='git'?`git = ${JSON.stringify(pathToFileURL(git).href)}, rev = "${revision}"`:`path = ${JSON.stringify(resolve(git,'rust').replaceAll('\\','/'))}`;
   // Equivalent to NoteX: the application itself still declares rmcp="3.0".
   const rustVersion=minimum?'1.88':output('rustc',['--version'],app).split(' ')[1];
   let manifest=`[package]\nname = "independent-${source}"\nversion = "0.0.0"\nedition = "2021"\nrust-version = "${rustVersion}"\n[dependencies]\nnox-mcp = { ${dependency} }\n`;
   for(const [name,version]of Object.entries(direct)){
    const original=rustManifest.split(/\r?\n/).find(l=>l.startsWith(name+' = '));
    let requirement=original.slice(original.indexOf(' = ')+3);
    // Exact pins belong only to the minimum test application, never to the SDK.
    if(minimum)requirement=requirement.replace(/"[\d.]+"/,`"=${version}"`);
    if(name==='rmcp')requirement=requirement.replace(/features = \[/,'features = ["client", ').replace(/version = "=?[\d.]+"/,'version = "3.0"');
    manifest+=`${name} = ${requirement}\n`;
   }
   manifest+='[dev-dependencies]\naxum = "0.8"\n';
   await writeFile(resolve(app,'Cargo.toml'),manifest);
   for(const name of ['tests','contracts','examples'])await cp(resolve(root,'rust',name),resolve(app,name),{recursive:true});
   await writeFile(resolve(app,'src/main.rs'),`fn main(){assert!(nox_mcp::load_manifest(r#"{"schemaVersion":1,"protocolVersion":"2.0","tools":[]}"#).is_ok());let _ = rmcp::model::ServerConfig::default();}\n`);
   await assert.rejects(readFile(resolve(app,'Cargo.lock'))); // Resolution must start fresh.
   run('cargo',['generate-lockfile'],app,env);
   // In the minimum application the broad rmcp declaration is narrowed by its lock.
   // SDK >=3.5 must prevent the resolver from satisfying it with rmcp 3.2.
   if(minimum)run('cargo',['update','-p','rmcp','--precise',direct.rmcp],app,env);
   const metadata=JSON.parse(output('cargo',['metadata','--locked','--format-version','1'],app,env));
   const mcp=metadata.packages.filter(p=>p.name==='rmcp');
   assert.equal(mcp.length,1);assert.ok(Number(mcp[0].version.split('.')[1])>=5);
   if(minimum)for(const [name,version]of Object.entries(direct))assert.ok(metadata.packages.some(p=>p.name===name&&p.version===version),`Minimum ${name}@${version} not selected`);
   console.log(`Independent Rust ${source}/${minimum?'minimum':'latest'}: `+metadata.packages.filter(p=>direct[p.name]).map(p=>p.name+'@'+p.version).join(', '));
   // Compile the production application without the client feature used by the
   // integration tests: dev feature unification must not hide missing SDK flags.
   await writeFile(resolve(app,'Cargo.toml'),manifest.replace('features = ["client", ','features = ['));
   run('cargo',['check','--locked','--bin',`independent-${source}`],app,env);
   await writeFile(resolve(app,'Cargo.toml'),manifest);
   run('cargo',['check','--locked','--all-targets'],app,env);
   run('cargo',['test','--locked','--all-targets'],app,env);
   run('cargo',['run','--locked'],app,env);
   run('cargo',['build','--locked','--example','discovery_fixture'],app,env);
   await exerciseDiscoveryFixtures([['rust',resolve(env.CARGO_TARGET_DIR,'debug/examples/discovery_fixture'+(process.platform==='win32'?'.exe':'')),[],{sdk:'rust@'+mcp[0].version.split('.').slice(0,2).join('.')}]]);
   // An explicitly incompatible application requirement must fail resolution.
   await writeFile(resolve(app,'Cargo.toml'),manifest.replace('rmcp = { version = "3.0"','rmcp = { version = "=3.2.0"'));
   assert.throws(()=>output('cargo',['generate-lockfile'],app,env),error=>/failed to select a version|conflict/i.test(error.stderr?.toString()??''));
  }
 }
 console.log(`Independent ${language} consumers passed (${minimum?'minimum':'latest compatible'}, ${process.platform}/${process.arch}).`);
}finally{
 assert.equal(dirname(temp),resolve(tmpdir()));await rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
