import assert from 'node:assert/strict';
import {test} from 'node:test';
import {consumerOptions,consumerProfile} from './consumer-options.mjs';

test('CI selects exactly its native language and dependency profile without npm flags',()=>{
  for(const language of ['go','rust'])for(const profile of ['minimum','latest']){
    assert.deepEqual(consumerOptions([],{NOX_CONSUMER_LANGUAGE:language,NOX_CONSUMER_PROFILE:profile}),{language,profile,minimum:profile==='minimum'});
  }
});
test('missing, invalid or conflicting CI consumer selection fails before invoking a toolchain',()=>{
  for(const env of [{NOX_CONSUMER_LANGUAGE:'rust'},{NOX_CONSUMER_PROFILE:'minimum'},{NOX_CONSUMER_LANGUAGE:'all',NOX_CONSUMER_PROFILE:'latest'},{NOX_CONSUMER_LANGUAGE:'rust',NOX_CONSUMER_PROFILE:'minimun'}])assert.throws(()=>consumerOptions([],env));
  assert.throws(()=>consumerOptions(['--language=go'],{NOX_CONSUMER_LANGUAGE:'rust',NOX_CONSUMER_PROFILE:'latest'}),/Conflicting/);
  assert.throws(()=>consumerOptions(['--minimum'],{NOX_CONSUMER_LANGUAGE:'rust',NOX_CONSUMER_PROFILE:'latest'}),/Conflicting/);
  assert.throws(()=>consumerOptions(['--language=rsut'],{}),/Usage/);
});
test('local consumer flags and the installed-package profile retain their meanings',()=>{
  assert.deepEqual(consumerOptions(['--language=rust','--minimum'],{}),{language:'rust',profile:'minimum',minimum:true});
  assert.deepEqual(consumerOptions(['--language=go'],{}),{language:'go',profile:'latest',minimum:false});
  assert.equal(consumerProfile([],{NOX_CONSUMER_PROFILE:'minimum'}),'minimum');
  assert.throws(()=>consumerProfile([],{NOX_CONSUMER_PROFILE:'wrong'}),/Invalid/);
});
