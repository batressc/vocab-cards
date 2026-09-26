import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEntry, slug } from '../entry.js';

test('el id se genera desde head con la regla documentada', () => {
  assert.equal(slug('give up'), 'give-up');
  assert.equal(slug('How’s it going?'), 'hows-it-going');
  assert.equal(slug("Would you mind…?"), 'would-you-mind');
  assert.equal(normalizeEntry({ head: 'Look Forward To', meaning: 'x' }).entry.id, 'look-forward-to');
});

test('sin head la entrada es un error', () => {
  assert.match(normalizeEntry({ meaning: 'x' }).error, /head/);
});

test('acepta el formato antiguo de pares [en, es] y normaliza tipo y nivel', () => {
  const { entry } = normalizeEntry({ head: 'x', meaning: 'y', kind: 'Phrasal', level: 'b1', ex: ['Hi', 'Hola'], examples: [['A', 'B']] });
  assert.equal(entry.kind, 'phrasal');
  assert.equal(entry.level, 'B1');
  assert.deepEqual(entry.ex, { en: 'Hi', es: 'Hola' });
  assert.deepEqual(entry.examples, [{ en: 'A', es: 'B' }]);
});

test('avisa de datos dudosos sin rechazar la entrada', () => {
  const r = normalizeEntry({ head: 'x', kind: 'rare', level: 'Z9' });
  assert.ok(r.entry);
  assert.ok(r.warnings.some(w => w.includes('meaning')));
  assert.ok(r.warnings.some(w => w.includes('rare')));
  assert.ok(r.warnings.some(w => w.includes('Z9')));
});
