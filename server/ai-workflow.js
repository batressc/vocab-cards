import { generateEntries } from './ai.js';
import { randomUUID } from 'node:crypto';

export const MAX_AI_INSTRUCTIONS = 2000;

const text = (value, max) => String(value ?? '').trim().slice(0, max);

function explicitSelection(body) {
  const provider = text(body?.provider, 64);
  const model = text(body?.model, 300);
  if (!provider || !model) throw Object.assign(new Error('Selecciona explícitamente un proveedor y un modelo.'), { status: 400 });
  return { provider, model };
}

/** Genera y valida una vista previa sin persistirla. */
export async function generatePreview(cfg, store, body, { edit = false, generate = generateEntries } = {}) {
  const selection = explicitSelection(body);
  const instructions = text(body?.instructions, MAX_AI_INSTRUCTIONS);
  const currentEntry = edit ? store.get(body?.entryId) : null;
  if (edit && !currentEntry) throw Object.assign(new Error('La tarjeta que quieres editar ya no existe.'), { status: 404 });

  const term = edit ? currentEntry.head : text(body?.term, 120);
  const hint = edit ? '' : text(body?.hint, 200);
  if (!term) throw Object.assign(new Error('Escribe la palabra o frase que quieres agregar.'), { status: 400 });

  const generationId = randomUUID();
  const started = Date.now();
  const record = (outcome, result = null) => store.recordAiGeneration({
    id:generationId, createdAt:new Date().toISOString(), operation:edit ? 'edit' : 'create',
    provider:selection.provider, model:selection.model,
    term:term.toLocaleLowerCase('en').replace(/\s+/g, ' ').slice(0, 120),
    entryId:edit ? currentEntry.id : null, outcome, durationMs:Date.now() - started,
    itemCount:result?.items.length || 0,
    validCount:result?.items.filter(item => item.entry && item.status !== 'error').length || 0
  });

  try {
    const ai = await generate(cfg, [{ term, hint }], {
      ...selection,
      instructions,
      currentEntry,
      opencodeSessionRequestLimit: body?.opencodeSessionRequestLimit,
      store
    });
    const source = `IA · ${ai.label}`;
    const result = store.plan([{ name: source, text: ai.text }], 'update', { withEntries: true });
    const valid = result.items.filter(item => item.entry && item.status !== 'error').length;
    if (edit && (result.items.length !== 1 || valid !== 1)) {
      record('invalid', result);
      throw Object.assign(new Error('La IA debe devolver exactamente una tarjeta válida para editar. Genera otra versión.'), { status: 422, generationRecorded:true });
    }
    record(valid ? 'success' : 'invalid', result);
    return { generationId, provider:ai.provider, label:ai.label, model:ai.model, source, text:ai.text, ...result };
  } catch (err) {
    if (!err.generationRecorded) record('provider_error');
    throw err;
  }
}
