import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { syncContracts } from './sync-contracts.mjs';

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'nox-contracts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL('../contracts/', import.meta.url), resolve(directory, 'contracts'), { recursive: true });
  await syncContracts(directory);
  return directory;
}

test('contract check is read-only, detects edited/missing files, and sync repairs them', async t => {
  const directory = await fixture(t);
  assert.deepEqual(await syncContracts(directory, { check: true }), []);
  const file = resolve(directory, 'go/contracts/request.schema.json');
  await writeFile(file, '{}\n');
  await unlink(resolve(directory, 'rust/contracts/error.schema.json'));
  await assert.rejects(syncContracts(directory, { check: true }), /Generated contracts are stale/);
  assert.equal(await readFile(file, 'utf8'), '{}\n');
  await syncContracts(directory);
  assert.deepEqual(await syncContracts(directory, { check: true }), []);
});

test('canonical changes reach all generated schemas, constants and TypeScript validators', async t => {
  const directory = await fixture(t);
  const defaultsFile = resolve(directory, 'contracts/defaults.json');
  const defaults = JSON.parse(await readFile(defaultsFile, 'utf8'));
  defaults.requestTimeoutMs = 23456;
  await writeFile(defaultsFile, JSON.stringify(defaults));
  const manifestFile = resolve(directory, 'contracts/manifest.schema.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  manifest.properties.tools.items.properties.custom = { type: 'string' };
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(syncContracts(directory, { check: true }), /stale/);
  await syncContracts(directory);
  for (const language of ['go', 'rust']) {
    assert.deepEqual(JSON.parse(await readFile(resolve(directory, `${language}/contracts/manifest.schema.json`), 'utf8')), manifest);
  }
  assert.match(await readFile(resolve(directory, 'typescript/src/contracts.generated.ts'), 'utf8'), /"custom": z.string\(\).optional\(\)/);
  for (const file of ['go/defaults.go', 'rust/src/defaults.rs', 'typescript/src/defaults.json']) assert.match(await readFile(resolve(directory, file), 'utf8'), /23456/);
});

test('stale corpus and obsolete embedded schemas cannot pass check', async t => {
  const directory = await fixture(t);
  await writeFile(resolve(directory, 'rust/contracts/obsolete.schema.json'), '{}');
  await writeFile(resolve(directory, 'go/contracts/conformance.json'), '{}');
  await assert.rejects(syncContracts(directory, { check: true }), /stale/);
  await syncContracts(directory);
  await assert.rejects(readFile(resolve(directory, 'rust/contracts/obsolete.schema.json')), /ENOENT/);
  assert.deepEqual(await syncContracts(directory, { check: true }), []);
});

test('unsupported assertions fail generation instead of silently weakening a contract', async t => {
  const directory = await fixture(t);
  const file = resolve(directory, 'contracts/manifest.schema.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  manifest.properties.tools.minItems = 1;
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(syncContracts(directory), /Unsupported contract keyword: minItems/);
});

test('a standalone schema cannot diverge from its definition inside a bridge envelope', async t => {
  const directory = await fixture(t);
  const file = resolve(directory, 'contracts/error.schema.json');
  const schema = JSON.parse(await readFile(file, 'utf8'));
  schema.properties.message.maxLength = 600;
  await writeFile(file, JSON.stringify(schema));
  await assert.rejects(syncContracts(directory), /Inconsistent embedded contract: error/);
});
