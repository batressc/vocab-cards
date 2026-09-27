import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTelemetryBatch } from '../telemetry.js';

const ids = {
  clientId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  sessionId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
};

test('normaliza únicamente eventos públicos permitidos', () => {
  const batch = normalizeTelemetryBatch({ ...ids, events:[
    { type:'search', term:'  Give   Up  ', resultCount:0 },
    { type:'known_changed', entryId:'give-up', value:true }
  ] });
  assert.equal(batch.events[0].term, 'give up');
  assert.equal(batch.events[1].value, 1);
});

test('rechaza campos sensibles, lotes grandes y combinaciones incoherentes', () => {
  assert.throws(() => normalizeTelemetryBatch({ ...ids, token:'secreto', events:[{ type:'search', term:'x', resultCount:0 }] }), /formato/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:Array.from({ length:51 }, () => ({ type:'search', term:'x', resultCount:0 })) }), /entre 1 y 50/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'audio_play', entryId:'bad id' }] }), /tarjeta/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'practice_changed' }] }), /estado/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'search', term:'x', resultCount:0, prompt:'no' }] }), /campos/);
});

test('rechaza tipos no exactos sin convertirlos a texto o booleanos', () => {
  assert.throws(() => normalizeTelemetryBatch({ ...ids, clientId:123, events:[{ type:'search', term:'x', resultCount:0 }] }), /identificadores/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'search', term:null, resultCount:0 }] }), /término/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'card_view', entryId:null }] }), /tarjeta/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'search', term:['x'], resultCount:0 }] }), /término/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'audio_play', entryId:{ id:'x' } }] }), /tarjeta/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'search', term:'x', resultCount:'0' }] }), /conteo/);
  assert.throws(() => normalizeTelemetryBatch({ ...ids, events:[{ type:'known_changed', entryId:'x', value:1 }] }), /estado/);
});
