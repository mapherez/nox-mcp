import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { expectedHttpStatus } from './discovery-http-policy.mjs';

const corpus = JSON.parse(await readFile(new URL('../contracts/discovery-conformance.json', import.meta.url), 'utf8'));
const invalid = corpus.negotiationCases.find(example => example.id === 'invalid-parameters');

test('handler validation follows the rmcp 3.6 behavior boundary, including later compatible minors', () => {
  for (const version of ['3.5.0', '3.5.9']) assert.equal(expectedHttpStatus(invalid, 'rust', version), 400);
  for (const version of ['3.6.0', '3.6.9', '3.7.0', '3.99.0']) assert.equal(expectedHttpStatus(invalid, 'rust', version), 200);
  assert.equal(expectedHttpStatus(invalid, 'typescript'), 200);
  assert.equal(expectedHttpStatus(invalid, 'go'), 400);
});

test('missing, unsupported, or prerelease SDK versions cannot silently inherit the old mapping', () => {
  for (const version of [undefined, '', '3.7', '3.7.0-rc.1', '03.7.0', '9007199254740992.0.0']) {
    assert.throws(() => expectedHttpStatus(invalid, 'rust', version), /SDK version/);
  }
  for (const version of ['3.4.9', '4.0.0']) {
    assert.throws(() => expectedHttpStatus(invalid, 'rust', version), /found 0.*instead of falling back/);
  }
});

test('negotiation and malformed envelopes keep mandatory HTTP 400 across profiles', () => {
  for (const example of corpus.negotiationCases.filter(example => example.code !== null && !example.invalidParams)) {
    for (const version of ['3.5.0', '3.6.0', '3.7.0']) assert.equal(expectedHttpStatus(example, 'rust', version), 400, example.id);
    for (const language of ['typescript', 'go']) assert.equal(expectedHttpStatus(example, language), 400, example.id);
  }
});

test('ambiguous or invalid test policies fail explicitly', () => {
  const profile = { minVersion: '3.6.0', beforeVersion: '4.0.0', status: 200 };
  const example = profiles => ({ ...invalid, httpStatusBySDK: { rust: profiles } });
  assert.throws(() => expectedHttpStatus(example([profile, profile]), 'rust', '3.7.0'), /found 2/);
  assert.throws(() => expectedHttpStatus(example([{ ...profile, beforeVersion: '3.5.0' }]), 'rust', '3.7.0'), /Invalid SDK version range/);
  assert.throws(() => expectedHttpStatus(example([{ ...profile, status: 999 }]), 'rust', '3.7.0'), /Invalid HTTP status/);
});
