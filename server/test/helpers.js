import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VocabStore } from '../vocab-store.js';

/** Crea un almacén sobre una base de datos temporal y devuelve una función para limpiarlo. */
export function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-test-'));
  const store = new VocabStore(join(dir, 'test.db'));
  return { store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export const entry = (head, extra = {}) => ({ head, meaning: `Significado de ${head}`, kind: 'word', level: 'A2', ipa: '/x/', ...extra });
export const source = (entries, name = 'prueba') => ({ name, text: JSON.stringify({ entries }) });
