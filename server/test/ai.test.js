import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { resolveAi, generateEntries } from '../ai.js';

/** Servidor que imita una API compatible con OpenAI. */
function mockProvider(handler) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => body += c).on('end', () => handler(JSON.parse(body || '{}'), req, res));
    }).listen(0, () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1` }));
  });
}

test('resolveAi informa qué falta en la configuración', () => {
  const saved = { ...process.env };
  for (const k of ['AI_API_KEY', 'GEMINI_API_KEY', 'OPENCODE_API_KEY']) delete process.env[k];
  try {
    assert.match(resolveAi({ ai: {} }).reason, /No hay proveedor/);
    assert.match(resolveAi({ ai: { provider: 'gemini' } }).reason, /GEMINI_API_KEY/);
    assert.match(resolveAi({ ai: { provider: 'azure', apiKey: 'k', model: 'm' } }).reason, /baseUrl/);
    assert.equal(resolveAi({ ai: { provider: 'ollama' } }).enabled, true);
    const go = resolveAi({ ai: { provider: 'opencode-go', apiKey: 'k' } });
    assert.equal(go.jsonMode, false);
  } finally {
    process.env = saved;
  }
});

test('genera con el prompt del archivo y descarta el bloque de razonamiento', async t => {
  let received;
  const { server, url } = await mockProvider((body, req, res) => {
    received = body;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: '<think>{"no": "esto"}</think>{"entries":[{"head":"set up"}]}' } }] }));
  });
  t.after(() => server.close());

  const r = await generateEntries({ ai: { provider: 'custom', baseUrl: url, model: 'm', apiKey: 'k' } }, [{ term: 'set up', hint: 'configurar' }]);
  assert.equal(r.text, '{"entries":[{"head":"set up"}]}');
  assert.match(received.messages[0].content, /profesor de inglés/, 'usa prompts/vocab-entry.prompt.md como mensaje de sistema');
  assert.equal(received.messages[1].content, 'LISTA:\nset up (configurar)');
});

test('traduce los errores del proveedor a mensajes claros', async t => {
  const { server, url } = await mockProvider((body, req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"message":"bad key"}}');
  });
  t.after(() => server.close());
  const warn = console.warn; console.warn = () => {};
  try {
    await assert.rejects(
      generateEntries({ ai: { provider: 'custom', baseUrl: url, model: 'm', apiKey: 'k' } }, [{ term: 'x' }]),
      /rechazó la clave de API/
    );
  } finally { console.warn = warn; }
});
