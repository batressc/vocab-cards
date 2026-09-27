import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';
import { ROOT } from './config.js';

/*
 * El prompt vive en prompts/ como Markdown para poder editarlo y versionarlo
 * sin tocar código. Se lee en cada generación: los cambios se aplican sin
 * reiniciar. Ruta configurable con "ai.promptFile" en config.json.
 */
export const DEFAULT_PROMPT_FILE = 'prompts/vocab-entry.prompt.md';

export async function loadSystemPrompt(cfg) {
  const file = String(cfg.ai?.promptFile || DEFAULT_PROMPT_FILE);
  const path = isAbsolute(file) ? file : resolve(ROOT, file);
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (err) {
    throw Object.assign(new Error(`No se pudo leer el prompt "${file}" (${err.code || err.message}).`), { status: 500 });
  }
}

/** Mensaje de usuario estructurado para creación o edición. */
export function userMessage(terms, { instructions = '', currentEntry = null } = {}) {
  const sections = ['LISTA:', ...terms.map(t => t.hint ? `${t.term} (${t.hint})` : t.term)];
  if (currentEntry) sections.push('', 'TARJETA ACTUAL (fuente autoritativa del servidor):', JSON.stringify(currentEntry));
  if (instructions) sections.push('', 'INSTRUCCIONES ADICIONALES:', instructions);
  return sections.join('\n');
}
