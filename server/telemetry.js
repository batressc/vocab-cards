const EVENT_TYPES = new Set(['search', 'card_view', 'card_flip', 'audio_play', 'known_changed', 'practice_changed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ENTRY_ID = /^[a-z0-9](?:[a-z0-9-]{0,118}[a-z0-9])?$/;

const ownKeys = (value, allowed) => Object.keys(value).every(key => allowed.includes(key));
const normalizedTerm = value => value.trim().toLocaleLowerCase('en').replace(/\s+/g, ' ').slice(0, 120);

export function normalizeTelemetryBatch(body, { maxEvents = 50 } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !ownKeys(body, ['clientId', 'sessionId', 'events'])) {
    throw new TypeError('El lote de telemetría no tiene el formato esperado.');
  }
  if (typeof body.clientId !== 'string' || typeof body.sessionId !== 'string' || !UUID.test(body.clientId) || !UUID.test(body.sessionId)) {
    throw new TypeError('Los identificadores de telemetría no son válidos.');
  }
  if (!Array.isArray(body.events) || !body.events.length || body.events.length > maxEvents) {
    throw new TypeError(`Envía entre 1 y ${maxEvents} eventos por lote.`);
  }

  const events = body.events.map((event, index) => {
    if (!event || typeof event !== 'object' || Array.isArray(event) || !ownKeys(event, ['type', 'entryId', 'term', 'resultCount', 'value'])) {
      throw new TypeError(`El evento ${index + 1} contiene campos no permitidos.`);
    }
    if (!EVENT_TYPES.has(event.type)) throw new TypeError(`El evento ${index + 1} tiene un tipo no permitido.`);
    if (event.entryId !== undefined && typeof event.entryId !== 'string') throw new TypeError(`El evento ${index + 1} tiene una tarjeta no válida.`);
    if (event.term !== undefined && typeof event.term !== 'string') throw new TypeError(`El evento ${index + 1} tiene un término no válido.`);
    if (event.resultCount !== undefined && (!Number.isSafeInteger(event.resultCount) || event.resultCount < 0 || event.resultCount > 1_000_000)) {
      throw new TypeError(`El evento ${index + 1} tiene un conteo no válido.`);
    }
    if (event.value !== undefined && typeof event.value !== 'boolean') throw new TypeError(`El evento ${index + 1} tiene un estado no válido.`);

    const entryId = event.entryId === undefined ? null : event.entryId.toLowerCase();
    if (entryId !== null && !ENTRY_ID.test(entryId)) throw new TypeError(`El evento ${index + 1} tiene una tarjeta no válida.`);
    const term = event.term === undefined ? null : normalizedTerm(event.term);
    const resultCount = event.resultCount === undefined ? null : event.resultCount;
    const value = event.value === undefined ? null : event.value;

    const requiresEntry = ['card_view', 'card_flip', 'audio_play', 'known_changed'].includes(event.type);
    if (requiresEntry !== Boolean(entryId)) throw new TypeError(`El evento ${index + 1} no coincide con su tarjeta.`);
    if (event.type === 'search' && (!term || resultCount === null)) throw new TypeError(`El evento ${index + 1} requiere término y resultados.`);
    if (event.type !== 'search' && (term !== null || resultCount !== null)) throw new TypeError(`El evento ${index + 1} contiene datos de búsqueda inesperados.`);
    if (['known_changed', 'practice_changed'].includes(event.type) !== (value !== null)) throw new TypeError(`El evento ${index + 1} no coincide con su estado.`);
    return { type:event.type, entryId, term, resultCount, value:value === null ? null : value ? 1 : 0 };
  });
  return { clientId:body.clientId.toLowerCase(), sessionId:body.sessionId.toLowerCase(), events };
}
