import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consumerProfile } from './consumer-options.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'nox-package-'));
const minimum = consumerProfile(process.argv.slice(2),process.env)==='minimum';
const destination = process.argv.slice(2).find(arg=>!arg.startsWith('--'));

try {
  if (!process.env.npm_execpath) throw new Error('Executa com npm run package:check.');
  const npm = (cwd, ...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Use the normal pack lifecycle: prepack builds dist, with no special CI artifact.
  const packOutput = JSON.parse(npm(root, 'pack', '--json', '--pack-destination', temporary));
  // npm 11 returns an array; npm 12 keys the same records by package name.
  const packages = Array.isArray(packOutput) ? packOutput : Object.values(packOutput);
  assert.equal(packages.length, 1, 'Expected exactly one packed package');
  const [packed] = packages;
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const paths = new Set(packed.files.map(file => file.path));
  assert.equal(packed.version, pkg.version);
  for (const path of paths) {
    // npm also includes license files in ancestors of a files entry.
    assert.ok(['package.json', 'README.md', 'MIGRATION_0_5.md', 'DISCOVERY.md', 'COMPATIBILITY_AUDIT.md', 'contracts/README.md', 'LICENSE', 'typescript/LICENSE'].includes(path) || path.startsWith('typescript/dist/'), `Unexpected packed file: ${path}`);
  }
  for (const file of ['MIGRATION_0_5.md', 'DISCOVERY.md', 'COMPATIBILITY_AUDIT.md', 'contracts/README.md']) assert.ok(paths.has(file), `Missing migration documentation: ${file}`);
  for (const entry of Object.values(pkg.exports)) {
    for (const path of Object.values(entry)) assert.ok(paths.has(path.replace(/^\.\//, '')), `Missing export: ${path}`);
  }
  assert.ok(!['preinstall', 'install', 'postinstall', 'prepare'].some(script => pkg.scripts[script]), 'Consumer install must not run build hooks');

  const consumer = resolve(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'nox-consumer-check', version: '1.0.0', private: true, type: 'module',
    dependencies: Object.fromEntries(Object.entries({...pkg.dependencies,...pkg.peerDependencies}).map(([name,range])=>[name,minimum?range.replace(/^[~^]/,''):range])),
  }));
  const tarball = resolve(temporary, packed.filename);
  // Keep lifecycle scripts enabled: this must work without tsc or SDK dev deps.
  npm(consumer, 'install', '--strict-peer-deps', '--foreground-scripts', '--no-audit', '--no-fund', tarball);
  const lock = JSON.parse(await readFile(resolve(consumer, 'package-lock.json'), 'utf8'));
  assert.ok(!Object.keys(lock.packages).some(path => /(?:^|\/)node_modules\/typescript$/.test(path)), 'Consumer unexpectedly installed TypeScript');
  assert.ok(!lock.packages['node_modules/@nox/mcp'].hasInstallScript, 'Package unexpectedly has an install hook');
  const installed = JSON.parse(await readFile(resolve(consumer, 'node_modules/@nox/mcp/package.json'), 'utf8'));
  assert.equal(installed.version, pkg.version);
  assert.deepEqual(Object.keys(installed.exports).sort(),['.','./bridge','./bridge/client','./bridge/server','./contract','./node'].sort(),'Unexpected public entry points');
  if(minimum)for(const [name,range]of Object.entries({...pkg.dependencies,...pkg.peerDependencies})){
    const dependency=JSON.parse(await readFile(resolve(consumer,'node_modules',name,'package.json'),'utf8'));
    assert.equal(dependency.version,range.replace(/^[~^]/,''),`Minimum ${name} was not installed`);
  }
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer, createServerFromManifest, interpretCli, DiscoveryService, fingerprint } from '@nox/mcp';
    import { compileToolSchema, loadToolManifest } from '@nox/mcp/contract';
    assert.equal(typeof createServer, 'function');
    assert.equal(interpretCli({version:'1.0'}).version,'1.0');
    assert.equal(fingerprint({a:1}).length,43);
    assert.deepEqual(new DiscoveryService('installed-package').catalog({viewId:'authorized',definitions:[]}).tools,[]);
    const manifest = {schemaVersion:1,protocolVersion:'2.0',tools:[]};
    assert.deepEqual(loadToolManifest(manifest), manifest);
    assert.equal(compileToolSchema({type:'string'})('installed schema policy'), true);
    await createServerFromManifest({appId:'consumer',name:'consumer',version:'1',manifest,bindings:{}}).close();
    await import('@nox/mcp/contract');
    await import('@nox/mcp/bridge');
    await import('@nox/mcp/bridge/client');
    await import('@nox/mcp/bridge/server');
    await import('@nox/mcp/node');
  `], { cwd: consumer, stdio: 'inherit' });

  // Exercise the installed tarball through the public Node adapter, with no
  // checkout imports and no application-level transport adaptation.
  await copyFile(resolve(root, 'scripts/consumer-http.mjs'), resolve(consumer, 'consumer-http.mjs'));
  execFileSync(process.execPath, ['consumer-http.mjs'], { cwd: consumer, stdio: 'inherit' });

  console.log('Independent npm graph: '+npm(consumer,'ls','--depth=0'));
  // Compilation belongs to the consuming app, not to an SDK install hook.
  npm(consumer,'install','--strict-peer-deps','--save-dev','--no-audit','--no-fund','typescript@'+pkg.devDependencies.typescript.replace(/^[~^]/,''),'@types/node@'+pkg.devDependencies['@types/node'].replace(/^[~^]/,''),'@types/ws@'+pkg.devDependencies['@types/ws'].replace(/^[~^]/,''));
  await writeFile(resolve(consumer,'consumer.ts'),`import {createServer,interpretCli,DiscoveryService} from '@nox/mcp';\nimport {compileToolSchema} from '@nox/mcp/contract';\nimport '@nox/mcp/node';\nimport '@nox/mcp/bridge';\nimport '@nox/mcp/bridge/client';\nimport '@nox/mcp/bridge/server';\nimport {z} from 'zod';\nconst server=createServer({appId:'consumer',name:'consumer',version:'0.5.0',tools:[{name:'echo',description:'External TS build',inputSchema:z.object({value:z.string()}),outputSchema:z.object({value:z.string()}),execute:async input=>input as {value:string}}]});\nif(!compileToolSchema({type:'string'})('value'))throw Error('schema');\ninterpretCli({version:'1.0'});\nnew DiscoveryService('external');\nawait server.close();\n`);
  execFileSync(process.execPath,[resolve(consumer,'node_modules/typescript/bin/tsc'),'consumer.ts','--module','nodenext','--target','es2022','--strict','--outDir','built'],{cwd:consumer,stdio:'inherit'});
  execFileSync(process.execPath,['built/consumer.js'],{cwd:consumer,stdio:'inherit'});
  if (destination) await copyFile(tarball, resolve(destination));
  console.log(`Verified @nox/mcp ${pkg.version}: ${packed.files.length} files, ${packed.size} bytes; ${minimum?'minimum':'latest compatible'} dependencies, consumer build and HTTP JSON/SSE passed.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
