import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAi, generateEntries } from '../ai.js';

const KEY_ENV = ['AI_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_API_KEY'];

test('loadConfig rechaza adminToken heredado con instrucciones de migración', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-config-'));
  const configPath = join(dir, 'config.json');
  const savedConfigPath = process.env.VOCAB_CONFIG;
  writeFileSync(configPath, '{"adminToken":"heredado"}');
  process.env.VOCAB_CONFIG = configPath;
  t.after(() => {
    if (savedConfigPath === undefined) delete process.env.VOCAB_CONFIG; else process.env.VOCAB_CONFIG = savedConfigPath;
    rmSync(dir, { recursive: true });
  });
  const { loadConfig } = await import('../config.js?legacy-admin-token');
  await assert.rejects(loadConfig(), /Muévelo a \.env como ADMIN_TOKEN.*elimina adminToken/);
});

function isolateKeyEnv(t, values = {}) {
  const saved = new Map(KEY_ENV.map(key => [key, process.env[key]]));
  for (const key of KEY_ENV) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

/** Servidor que imita una API compatible con OpenAI. */
function mockProvider(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c).on('end', () => handler(JSON.parse(body || '{}'), req, res));
    }).listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

test('resolveAi informa qué falta e ignora claves de config.json', t => {
  isolateKeyEnv(t);
  assert.match(resolveAi({ ai: {} }).reason, /No hay proveedor/);
  assert.match(resolveAi({ ai: { provider: 'gemini', apiKey: 'no-se-usa' } }).reason, /GEMINI_API_KEY/);
  assert.match(resolveAi({ ai: { provider: 'azure', model: 'm' } }).reason, /baseUrl/);
  assert.equal(resolveAi({ ai: { provider: 'ollama' } }).enabled, true);
});

test('resolveAi usa variables del proveedor y da prioridad a AI_API_KEY', t => {
  isolateKeyEnv(t, { GEMINI_API_KEY: 'proveedor' });
  assert.equal(resolveAi({ ai: { provider: 'gemini' } }).apiKey, 'proveedor');
  process.env.AI_API_KEY = 'general';
  assert.equal(resolveAi({ ai: { provider: 'gemini' } }).apiKey, 'general');
  process.env.OPENCODE_API_KEY = 'opencode';
  const go = resolveAi({ ai: { provider: 'opencode-go' } });
  assert.equal(go.jsonMode, false);
});

test('genera con el prompt del archivo y descarta el bloque de razonamiento', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'prueba' });
  let received;
  const { server, url } = await mockProvider((body, req, res) => {
    received = body;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '<think>{"no": "esto"}</think>{"entries":[{"head":"set up"}]}' } }] }));
  });
  t.after(() => server.close());

  const r = await generateEntries({ ai: { provider: 'custom', baseUrl: url, model: 'm' } }, [{ term: 'set up', hint: 'configurar' }]);
  assert.equal(r.text, '{"entries":[{"head":"set up"}]}');
  assert.match(received.messages[0].content, /profesor de inglés/, 'usa prompts/vocab-entry.prompt.md como mensaje de sistema');
  assert.equal(received.messages[1].content, 'LISTA:\nset up (configurar)');
});

test('traduce los errores del proveedor a mensajes claros', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'prueba' });
  const { server, url } = await mockProvider((body, req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  t.after(() => server.close());
  const warn = console.warn; console.warn = () => {};
  try {
    await assert.rejects(
      generateEntries({ ai: { provider: 'custom', baseUrl: url, model: 'm' } }, [{ term: 'x' }]),
      /rechazó la clave de API/
    );
  } finally { console.warn = warn; }
});
