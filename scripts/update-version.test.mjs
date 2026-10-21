import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readVersionFiles, updateVersion } from './update-version.mjs';
import { release } from './release.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function repository(t) {
  const root = await mkdtemp(resolve(tmpdir(), 'nox-version-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(resolve(root, 'rust'));
  await mkdir(resolve(root, 'scripts'));
  await copyFile(new URL('./update-version.mjs', import.meta.url), resolve(root, 'scripts/update-version.mjs'));
  await copyFile(new URL('./release.mjs', import.meta.url), resolve(root, 'scripts/release.mjs'));
  await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: '@nox/mcp', version: '0.3.0', dependencies: { example: '0.1.0' } }, null, 2) + '\n');
  await writeFile(resolve(root, 'package-lock.json'), JSON.stringify({ name: '@nox/mcp', version: '0.2.0', lockfileVersion: 3, packages: {
    '': { name: '@nox/mcp', version: '0.2.0' }, 'node_modules/example': { version: '0.1.0' },
  } }, null, 2) + '\n');
  await writeFile(resolve(root, 'rust/Cargo.toml'), '[package]\r\nname = "nox-mcp"\r\nversion = "0.1.0"\r\nrust-version = "1.88"\r\n\r\n[dependencies]\r\nexample = "0.1.0"\r\n');
  await writeFile(resolve(root, 'rust/Cargo.lock'), '# Generated\nversion = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0"\n\n[[package]]\nname = "nox-mcp"\nversion = "0.1.0"\ndependencies = ["example"]\n');
  await writeFile(resolve(root, 'go.mod'), 'module github.com/mapherez/nox-mcp\n\ngo 1.26.0\n');
  git(root, 'init');
  git(root, 'config', 'user.name', 'Version test');
  git(root, 'config', 'user.email', 'version-test@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'config', 'tag.gpgsign', 'false');
  git(root, 'config', 'core.hooksPath', resolve(root, 'no-hooks'));
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'Initial fixture');
  return root;
}

async function prepareVersion(root, version) {
  for (const file of await readVersionFiles(root)) {
    await writeFile(resolve(root, file.path), file.render(version));
  }
  git(root, 'add', '.');
  git(root, 'commit', '-m', `Prepare ${version}`);
}

test('release accepts a filesystem alias of the actual repository root', async t => {
  const root = await repository(t);
  const alias = root + '-alias';
  await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => unlink(alias));
  assert.equal(await updateVersion(alias, '0.4.0'), 'v0.4.0');
  assert.equal(git(root, 'rev-parse', 'v0.4.0^{commit}'), git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'status', '--porcelain'), '');
});

test('release still rejects a subdirectory with valid version files inside a parent repository', async t => {
  const root = await repository(t);
  const child = resolve(root, 'nested');
  await mkdir(resolve(child, 'rust'), { recursive: true });
  for (const path of ['package.json', 'package-lock.json', 'rust/Cargo.toml', 'rust/Cargo.lock', 'go.mod']) {
    await copyFile(resolve(root, path), resolve(child, path));
  }
  git(root, 'add', '.'); git(root, 'commit', '-m', 'Nested fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(updateVersion(child, '0.4.0'), /repositorio pai/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'tag', '--list'), '');
});

test('release synchronizes only project versions and tags the updated commit', async t => {
  const root = await repository(t);
  const initial = await readVersionFiles(root);
  assert.deepEqual(initial.map(file => file.versions), [['0.3.0'], ['0.2.0', '0.2.0'], ['0.1.0'], ['0.1.0']]);
  const head = git(root, 'rev-parse', 'HEAD');
  assert.equal(await updateVersion(root, 'v0.4.0-beta.1'), 'v0.4.0-beta.1');
  for (const file of await readVersionFiles(root)) {
    assert.ok(file.versions.every(version => version === '0.4.0-beta.1'));
    assert.equal(git(root, 'show', `v0.4.0-beta.1:${file.path}`).replaceAll('\r\n', '\n'), file.original.replaceAll('\r\n', '\n').trim());
  }
  assert.notEqual(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'rev-parse', 'v0.4.0-beta.1^{commit}'), git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'cat-file', '-t', 'v0.4.0-beta.1'), 'tag');
  assert.equal(git(root, 'status', '--porcelain'), '');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.dependencies.example, '0.1.0');
  assert.equal(lock.packages['node_modules/example'].version, '0.1.0');
  assert.equal(await readFile(resolve(root, 'rust/Cargo.lock'), 'utf8'), initial[3].original.replace('name = "nox-mcp"\nversion = "0.1.0"', 'name = "nox-mcp"\nversion = "0.4.0-beta.1"'));
  assert.equal(await readFile(resolve(root, 'go.mod'), 'utf8'), 'module github.com/mapherez/nox-mcp\n\ngo 1.26.0\n');
});

test('updateVersion preserves original CRLF line endings in rust/Cargo.toml', async t => {
  const root = await repository(t);
  const path = resolve(root, 'rust/Cargo.toml');
  const original = await readFile(path, 'utf8');
  assert.match(original, /\r\n/);
  assert.doesNotMatch(original, /(?<!\r)\n/);

  await updateVersion(root, '0.4.0-beta.1');

  // Compare the raw working-tree contents, without Git or newline normalization.
  const updated = await readFile(path, 'utf8');
  assert.equal(updated, original.replace('version = "0.1.0"', 'version = "0.4.0-beta.1"'));
  assert.match(updated, /\r\n/);
  assert.doesNotMatch(updated, /(?<!\r)\n/);
});

test('invalid versions, incompatible Go majors, existing tags and dirty trees change nothing', async t => {
  const root = await repository(t);
  const initial = await readVersionFiles(root);
  const head = git(root, 'rev-parse', 'HEAD');
  for (const version of ['bad', '0.04.0', '0.4.0-01', '0.4.0\nextra', '0.4.0+build']) {
    await assert.rejects(updateVersion(root, version), /Versao invalida/);
  }
  await assert.rejects(updateVersion(root, '2.0.0'), /module path Go/);
  git(root, 'tag', 'v0.4.0');
  await assert.rejects(updateVersion(root, '0.4.0'), /ja existe/);
  await writeFile(resolve(root, 'uncommitted.txt'), 'keep this');
  await assert.rejects(updateVersion(root, '0.5.0'), /commit ou stash/);
  assert.equal(await readFile(resolve(root, 'uncommitted.txt'), 'utf8'), 'keep this');
  assert.deepEqual((await readVersionFiles(root)).map(file => file.original), initial.map(file => file.original));
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'tag', '--list'), 'v0.4.0');
});

test('failed commit restores version files without creating a tag', async t => {
  const root = await repository(t);
  const initial = await readVersionFiles(root);
  git(root, 'config', 'core.hooksPath', resolve(root, '.git/hooks'));
  await writeFile(resolve(root, '.git/hooks/pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(updateVersion(root, '0.4.0'));
  assert.deepEqual((await readVersionFiles(root)).map(file => file.original), initial.map(file => file.original));
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'tag', '--list'), '');
});

test('interactive script reports inconsistencies and accepts the typed version from any directory', async t => {
  const root = await repository(t);
  const result = spawnSync(process.execPath, [resolve(root, 'scripts/update-version.mjs')], {
    cwd: tmpdir(), input: '0.4.0\n', encoding: 'utf8', timeout: 30000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Versao atual \(package.json\): 0\.3\.0/);
  assert.match(result.stdout, /Existem versoes inconsistentes/);
  assert.match(result.stdout, /Nova versao/);
  assert.match(result.stdout, /tag v0\.4\.0 criados/);
  assert.equal(git(root, 'rev-parse', 'v0.4.0^{commit}'), git(root, 'rev-parse', 'HEAD'));
});

test('interactive release shows current versions and cancels on blank input or EOF without changes', async t => {
  const root = await repository(t);
  const head = git(root, 'rev-parse', 'HEAD');
  const initial = await readVersionFiles(root);
  for (const input of ['\n', '', '  \n']) {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts/release.mjs')], {
      cwd: tmpdir(), input, encoding: 'utf8', timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Versao atual \(package.json\): 0\.3\.0/);
    assert.match(result.stdout, /package-lock.json: 0\.2\.0, 0\.2\.0/);
    assert.match(result.stdout, /rust\/Cargo.toml: 0\.1\.0/);
    assert.match(result.stdout, /Existem versoes inconsistentes/);
    assert.match(result.stdout, /Versao a publicar \(Enter para cancelar\)/);
    assert.match(result.stdout, /Cancelado/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.equal(git(root, 'status', '--porcelain'), '');
    assert.equal(git(root, 'tag', '--list'), '');
    assert.deepEqual((await readVersionFiles(root)).map(file => file.original), initial.map(file => file.original));
  }
});

test('interactive release passes the selected prepared version through existing release checks', async t => {
  const root = await repository(t);
  await prepareVersion(root, '0.5.0');
  git(root, 'tag', 'v0.5.0');
  git(root, 'remote', 'add', 'origin', root);
  const head = git(root, 'rev-parse', 'HEAD');
  const script = resolve(root, 'scripts/release.mjs');
  const run = (args, input = '') => spawnSync(process.execPath, [script, ...args], {
    cwd: tmpdir(), input, encoding: 'utf8', timeout: 30000,
  });
  const interactive = run([], 'v0.5.0\n');
  assert.equal(interactive.status, 1);
  assert.match(interactive.stdout, /Versao atual \(package.json\): 0\.5\.0/);
  assert.doesNotMatch(interactive.stdout, /Existem versoes inconsistentes/);
  assert.match(interactive.stderr, /A tag v0\.5\.0 ja existe em origin/);
  const explicit = run(['0.5.0']);
  assert.equal(explicit.status, 1);
  assert.match(explicit.stderr, /A tag v0\.5\.0 ja existe em origin/);
  assert.doesNotMatch(explicit.stdout, /Versao a publicar/);
  const invalid = run([], 'not-a-version\n');
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Versao invalida/);
  const extra = run(['0.5.0', 'unexpected']);
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /Uso: npm run release/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'tag', '--list'), 'v0.5.0');
});

test('release validates synchronized versions before committing and pushes both refs to origin', async t => {
  const root = await repository(t);
  const remote = await mkdtemp(resolve(tmpdir(), 'nox-release-origin-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  const head = git(root, 'rev-parse', 'HEAD');
  let checked = false;
  const url = await release(root, '0.4.0', { check: async () => {
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.equal(git(root, 'tag', '--list'), '');
    for (const file of await readVersionFiles(root)) assert.ok(file.versions.every(version => version === '0.4.0'));
    checked = true;
  } });
  assert.ok(checked);
  assert.equal(url, 'https://github.com/mapherez/nox-mcp/releases/download/v0.4.0/nox-mcp.tgz');
  assert.equal(git(remote, 'rev-parse', 'v0.4.0^{commit}'), git(root, 'rev-parse', 'HEAD'));
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD');
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), git(root, 'rev-parse', 'HEAD'));
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'chore: release v0.4.0');
});

test('failed release checks restore versions and never commit, tag or push', async t => {
  const root = await repository(t);
  git(root, 'remote', 'add', 'origin', root);
  const initial = await readVersionFiles(root);
  const head = git(root, 'rev-parse', 'HEAD');
  await assert.rejects(release(root, '0.4.0', { check: () => { throw new Error('Tests failed'); } }), /Tests failed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'tag', '--list'), '');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual((await readVersionFiles(root)).map(file => file.original), initial.map(file => file.original));
});

test('release publishes an already prepared version after checks without an empty commit', async t => {
  const root = await repository(t);
  await prepareVersion(root, '0.5.0');
  const head = git(root, 'rev-parse', 'HEAD');
  const initial = await readVersionFiles(root);
  await assert.rejects(updateVersion(root, '0.5.0'), /ja usam essa versao.*npm run release/);
  const remote = await mkdtemp(resolve(tmpdir(), 'nox-release-origin-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  let checked = false;
  const url = await release(root, '0.5.0', { check: () => {
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.equal(git(root, 'tag', '--list'), '');
    assert.equal(git(remote, 'for-each-ref'), '');
    checked = true;
  } });
  assert.ok(checked, 'Prepared releases must run the same validation');
  assert.equal(url, 'https://github.com/mapherez/nox-mcp/releases/download/v0.5.0/nox-mcp.tgz');
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'cat-file', '-t', 'v0.5.0'), 'tag');
  assert.equal(git(remote, 'rev-parse', 'v0.5.0^{commit}'), head);
  const branch = git(root, 'symbolic-ref', '--short', 'HEAD');
  assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), head);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual((await readVersionFiles(root)).map(file => file.original), initial.map(file => file.original));
  await assert.rejects(release(root, '0.5.0', { check: () => assert.fail('Must not retest an existing tag') }), /ja existe/);
});

test('failed checks for a prepared release leave the commit, files and remote intact', async t => {
  const root = await repository(t);
  await prepareVersion(root, '0.5.0');
  git(root, 'remote', 'add', 'origin', root);
  const head = git(root, 'rev-parse', 'HEAD');
  const initial = await readVersionFiles(root);
  await assert.rejects(release(root, '0.5.0', { check: () => { throw new Error('Tests failed'); } }), /Tests failed/);
  assert.equal(git(root, 'rev-parse', 'HEAD'), head);
  assert.equal(git(root, 'tag', '--list'), '');
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.deepEqual((await readVersionFiles(root)).map(file => file.original), initial.map(file => file.original));
});

test('prepared release validation cannot leave unrelated tracked, staged or untracked changes', async t => {
  for (const kind of ['tracked', 'staged', 'untracked']) await t.test(kind, async t => {
    const root = await repository(t);
    await prepareVersion(root, '0.5.0');
    git(root, 'remote', 'add', 'origin', root);
    const head = git(root, 'rev-parse', 'HEAD');
    await assert.rejects(release(root, '0.5.0', { check: async () => {
      const file = kind === 'untracked' ? 'unexpected.txt' : 'go.mod';
      await writeFile(resolve(root, file), 'unexpected validation change');
      if (kind === 'staged') git(root, 'add', file);
    } }), /validacao alterou ficheiros/);
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    assert.equal(git(root, 'tag', '--list'), '');
    assert.equal(await readFile(resolve(root, kind === 'untracked' ? 'unexpected.txt' : 'go.mod'), 'utf8'), 'unexpected validation change');
  });
});

test('a remote-only tag blocks release before any changes', async t => {
  const root = await repository(t);
  const remote = await mkdtemp(resolve(tmpdir(), 'nox-release-origin-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'tag', '-a', 'v0.4.0', '-m', 'Existing release');
  git(root, 'push', 'origin', 'refs/tags/v0.4.0');
  const originalTag = git(remote, 'rev-parse', 'v0.4.0');
  git(root, 'tag', '-d', 'v0.4.0');
  await assert.rejects(release(root, '0.4.0', { check: () => assert.fail('Must not test') }), /ja existe em origin/);
  assert.equal(git(root, 'status', '--porcelain'), '');
  assert.equal(git(root, 'tag', '--list'), '');
  assert.equal(git(remote, 'rev-parse', 'v0.4.0'), originalTag);
});

test('Go major 2 requires /v2 and accepts the matching module path', async t => {
  const root = await repository(t);
  await writeFile(resolve(root, 'go.mod'), 'module github.com/mapherez/nox-mcp/v2\n\ngo 1.26.0\n');
  git(root, 'add', 'go.mod');
  git(root, 'commit', '-m', 'Migrate Go module to v2');
  await assert.rejects(updateVersion(root, '1.0.0'), /module path Go/);
  await assert.rejects(updateVersion(root, '3.0.0'), /module path Go/);
  assert.equal(await updateVersion(root, '2.0.0'), 'v2.0.0');
});

test('atomic push failure retains local release but publishes neither ref', async t => {
  const root = await repository(t);
  const remote = await mkdtemp(resolve(tmpdir(), 'nox-release-origin-'));
  t.after(() => rm(remote, { recursive: true, force: true }));
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(resolve(remote, 'hooks/pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(release(root, '0.4.0', { check: () => {} }), /Push falhou.*ficaram locais/);
  assert.equal(git(root, 'cat-file', '-t', 'v0.4.0'), 'tag');
  assert.equal(git(remote, 'for-each-ref'), '');
});

test('CI validates tag and SDK versions on a detached checkout', async t => {
  const root = await repository(t);
  await updateVersion(root, '0.4.0');
  git(root, 'checkout', '--detach', 'v0.4.0');
  const check = tag => spawnSync(process.execPath, [fileURLToPath(new URL('./check-release-version.mjs', import.meta.url)), tag], { cwd: root, encoding: 'utf8' });
  assert.equal(check('v0.4.0').status, 0);
  const mismatched = check('v0.5.0');
  assert.equal(mismatched.status, 1);
  assert.match(mismatched.stderr, /nao corresponde/);
  assert.equal(check('0.4.0').status, 1);
});
