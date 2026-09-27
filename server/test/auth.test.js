import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAuth } from '../auth.js';

const response = () => ({
  statusCode:200,
  body:null,
  status(code){ this.statusCode = code; return this; },
  json(body){ this.body = body; return this; }
});

test('el middleware Bearer rechaza una clave ausente y acepta la configurada', async () => {
  const auth = createAuth(async () => ({ adminToken:'clave-administrativa' }));
  let passed = false;
  const denied = response();
  await auth.require({ get:() => '' }, denied, () => { passed = true; });
  assert.equal(passed, false);
  assert.equal(denied.statusCode, 401);

  const allowed = response();
  await auth.require({ get:() => 'Bearer clave-administrativa' }, allowed, () => { passed = true; });
  assert.equal(passed, true);
});

test('las rutas de editar y eliminar permanecen detrás de autenticación Bearer', () => {
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const guard = source.indexOf("admin.use(writeLimiter, auth.require)");
  assert.ok(guard >= 0);
  assert.ok(source.indexOf("admin.put('/entries/:id'", guard) > guard);
  assert.ok(source.indexOf("admin.delete('/entries/:id'", guard) > guard);
  assert.match(source, /vocab\.delete\('\/entries\/:id', writeLimiter, auth\.require/);
});
