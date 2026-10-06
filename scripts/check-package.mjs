import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'nox-package-'));

try {
  if (!process.env.npm_execpath) throw new Error('Executa com npm run package:check.');
  const npm = (cwd, ...args) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
  });
  // Use the normal pack lifecycle: prepack builds dist, with no special CI artifact.
  const [packed] = JSON.parse(npm(root, 'pack', '--json', '--pack-destination', temporary));
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const paths = new Set(packed.files.map(file => file.path));
  assert.equal(packed.version, pkg.version);
  for (const path of paths) {
    // npm also includes license files in ancestors of a files entry.
    assert.ok(['package.json', 'README.md', 'LICENSE', 'typescript/LICENSE'].includes(path) || path.startsWith('typescript/dist/'), `Unexpected packed file: ${path}`);
  }
  for (const entry of Object.values(pkg.exports)) {
    for (const path of Object.values(entry)) assert.ok(paths.has(path.replace(/^\.\//, '')), `Missing export: ${path}`);
  }
  assert.ok(!['preinstall', 'install', 'postinstall', 'prepare'].some(script => pkg.scripts[script]), 'Consumer install must not run build hooks');

  const consumer = resolve(temporary, 'consumer');
  await mkdir(consumer);
  await writeFile(resolve(consumer, 'package.json'), JSON.stringify({ name: 'nox-consumer-check', version: '1.0.0', private: true, type: 'module',
    dependencies: { ws: pkg.peerDependencies.ws },
  }));
  const tarball = resolve(temporary, packed.filename);
  // Keep lifecycle scripts enabled: this must work without tsc or SDK dev deps.
  npm(consumer, 'install', '--foreground-scripts', '--no-audit', '--no-fund', tarball);
  const lock = JSON.parse(await readFile(resolve(consumer, 'package-lock.json'), 'utf8'));
  assert.ok(!Object.keys(lock.packages).some(path => /(?:^|\/)node_modules\/typescript$/.test(path)), 'Consumer unexpectedly installed TypeScript');
  assert.ok(!lock.packages['node_modules/@nox/mcp'].hasInstallScript, 'Package unexpectedly has an install hook');
  const installed = JSON.parse(await readFile(resolve(consumer, 'node_modules/@nox/mcp/package.json'), 'utf8'));
  assert.equal(installed.version, pkg.version);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { createServer } from '@nox/mcp';
    assert.equal(typeof createServer, 'function');
    await import('@nox/mcp/contract');
    await import('@nox/mcp/bridge');
    await import('@nox/mcp/bridge/client');
    await import('@nox/mcp/bridge/server');
  `], { cwd: consumer, stdio: 'inherit' });

  if (process.argv[2]) await copyFile(tarball, resolve(process.argv[2]));
  console.log(`Verified @nox/mcp ${pkg.version}: ${packed.files.length} files, ${packed.size} bytes; consumer install and imports passed without TypeScript.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
