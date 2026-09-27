import { generateEntries } from './ai.js';

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

  const ai = await generate(cfg, [{ term, hint }], {
    ...selection,
    instructions,
    currentEntry,
    opencodeSessionRequestLimit: body?.opencodeSessionRequestLimit,
    store
  });
  const source = `IA · ${ai.label}`;
  const result = store.plan([{ name: source, text: ai.text }], 'update', { withEntries: true });
  if (edit && (result.items.length !== 1 || !result.items[0].entry || result.items[0].status === 'error')) {
    throw Object.assign(new Error('La IA debe devolver exactamente una tarjeta válida para editar. Genera otra versión.'), { status: 422 });
  }
  return { provider: ai.provider, label: ai.label, model: ai.model, source, text: ai.text, ...result };
}
