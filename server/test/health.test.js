import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHealthHandler } from '../health.js';
import { tempStore } from './helpers.js';

function response() {
  return {
    statusCode: 200,
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('el health endpoint comprueba SQLite sin consultar proveedores externos', t => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  const res = response();
  createHealthHandler(store)({}, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { status: 'ok', database: 'ok' });
  assert.equal(res.headers['Cache-Control'], 'no-store');
});

test('el health endpoint responde 503 sin filtrar el error de SQLite', () => {
  const res = response();
  createHealthHandler({ checkHealth() { throw new Error('ruta privada'); } })({}, res);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { status: 'unavailable', database: 'unavailable' });
  assert.doesNotMatch(JSON.stringify(res.body), /privada/);
});
