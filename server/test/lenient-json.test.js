import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLenientJson, extractJsonBlocks } from '../lenient-json.js';

test('acepta comentarios y comas finales sin alterar el contenido de las cadenas', () => {
  const data = parseLenientJson('// comentario\n[ { "a": "x // no es comentario", "b": "/* tampoco */", }, ]');
  assert.deepEqual(data, [{ a: 'x // no es comentario', b: '/* tampoco */' }]);
});

test('extrae el JSON de una respuesta de IA con bloque de código y texto alrededor', () => {
  const blocks = extractJsonBlocks('Aquí tienes:\n```json\n{"entries":[]}\n```\n¡Listo!');
  assert.deepEqual(blocks.map(b => JSON.parse(b)), [{ entries: [] }]);
});

test('sin bloque de código toma desde la primera llave hasta la última', () => {
  assert.equal(extractJsonBlocks('Respuesta: {"a":1} fin')[0], '{"a":1}');
});
