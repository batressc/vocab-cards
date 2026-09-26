/* Conector de generación IA. El catálogo y las credenciales viven solo en backend. */
import { loadSystemPrompt, userMessage } from './prompt.js';
import { randomUUID } from 'node:crypto';
import { aiModelCatalog, findCatalogModel, resolveProvider } from './ai-models.js';

export const OPENCODE_USER_AGENT = 'vocab-cards/1.0.0';
export const OPENCODE_SESSION_LIMIT = Object.freeze({ default: 50, min: 1, max: 1000 });

class AiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

export async function publicAiInfo(cfg, options = {}) {
  const snapshot = await (options.catalog || aiModelCatalog).get(cfg, { force: options.force });
  if (!snapshot.default) {
    return {
      enabled: false,
      reason: 'No se pudo descubrir ningún modelo de los proveedores configurados.',
      ...snapshot
    };
  }
  const selected = findCatalogModel(snapshot, snapshot.default);
  return {
    enabled: true,
    provider: selected.provider.id,
    label: selected.provider.label,
    model: selected.model.id,
    ...snapshot
  };
}

export async function resolveAi(cfg, selection, options = {}) {
  const snapshot = await (options.catalog || aiModelCatalog).get(cfg);
  const requested = selection?.provider || selection?.model ? selection : snapshot.default;
  const selected = findCatalogModel(snapshot, requested);
  if (!selected) return { enabled: false, status: 400, reason: 'El modelo de IA seleccionado ya no está disponible. Actualiza el catálogo y elige otro modelo.' };
  const provider = resolveProvider(cfg, selected.provider.id);
  if (!provider.enabled) return provider;
  return {
    ...provider,
    model: selected.model.id,
    protocol: selected.model.protocol || provider.protocol,
    supportsTemperature: selected.model.supportsTemperature !== false,
    snapshot
  };
}

function opencodeSessionLimit(value) {
  if (value === undefined) return OPENCODE_SESSION_LIMIT.default;
  if (!Number.isSafeInteger(value) || value < OPENCODE_SESSION_LIMIT.min || value > OPENCODE_SESSION_LIMIT.max) {
    throw new AiError(`El límite de sesión de OpenCode Go debe ser un entero entre ${OPENCODE_SESSION_LIMIT.min} y ${OPENCODE_SESSION_LIMIT.max}.`, 400);
  }
  return value;
}

export function createOpenCodeSessionAllocator(createId = randomUUID) {
  let id = '';
  let requests = 0;
  return limit => {
    if (!id || requests >= limit) {
      id = createId();
      requests = 0;
    }
    requests++;
    return id;
  };
}

const allocateOpenCodeSession = createOpenCodeSessionAllocator();

function explain(status, detail, provider) {
  if (status === 401 || status === 403) return `${provider.label} rechazó la clave de API. Revísala en la configuración.`;
  if (status === 404) return `${provider.label} no encontró el modelo "${provider.model}" o la dirección configurada.`;
  if (status === 429) return `${provider.label} indica que se alcanzó el límite de uso o la cuota. Espera un momento o revisa tu plan.`;
  if (status >= 500) return `${provider.label} tuvo un error temporal (${status}). Inténtalo de nuevo.`;
  return `${provider.label} respondió ${status}${detail ? `: ${detail}` : '.'}`;
}

function generationHeaders(provider) {
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) {
    if (provider.auth === 'api-key') headers['api-key'] = provider.apiKey;
    else if (provider.auth === 'x-api-key') headers['x-api-key'] = provider.apiKey;
    else headers.authorization = `Bearer ${provider.apiKey}`;
  }
  return headers;
}

function generationRequest(provider, system, user, terms) {
  const temperature = provider.temperature !== null && provider.supportsTemperature ? provider.temperature : undefined;
  if (provider.protocol === 'messages') {
    const body = { model: provider.model, max_tokens: 1500 * Math.max(1, terms.length) + 500, system, messages: [{ role: 'user', content: user }] };
    if (temperature !== undefined) body.temperature = temperature;
    return {
      url: `${provider.baseUrl}/messages`,
      headers: { ...generationHeaders(provider), 'anthropic-version': '2023-06-01' },
      body
    };
  }
  if (provider.protocol === 'responses') {
    const body = {
      model: provider.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: user }] }
      ]
    };
    if (temperature !== undefined) body.temperature = temperature;
    return { url: `${provider.baseUrl}/responses`, headers: generationHeaders(provider), body };
  }
  const body = { model: provider.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  if (provider.jsonMode) body.response_format = { type: 'json_object' };
  if (temperature !== undefined) body.temperature = temperature;
  return { url: `${provider.baseUrl}/chat/completions`, headers: generationHeaders(provider), body };
}

function responseText(protocol, data) {
  if (protocol === 'messages') return (data?.content || []).filter(block => block.type === 'text').map(block => block.text).join('');
  if (protocol === 'responses') {
    if (typeof data?.output_text === 'string') return data.output_text;
    return (data?.output || []).flatMap(item => item?.content || []).filter(item => item?.type === 'output_text').map(item => item.text).join('');
  }
  return data?.choices?.[0]?.message?.content ?? '';
}

/** Pide a la IA las entradas para los términos dados. Devuelve el texto de la respuesta. */
export async function generateEntries(cfg, terms, options = {}) {
  const provider = await resolveAi(cfg, { provider: options.provider, model: options.model }, options);
  if (!provider.enabled) throw new AiError(provider.reason, provider.status || 503);

  const system = await loadSystemPrompt(cfg);
  const request = generationRequest(provider, system, userMessage(terms), terms);
  if (provider.provider === 'opencode-go') {
    const limit = opencodeSessionLimit(options.opencodeSessionRequestLimit);
    request.headers['user-agent'] = OPENCODE_USER_AGENT;
    request.headers['x-opencode-session'] = (options.allocateOpenCodeSession || allocateOpenCodeSession)(limit);
  }

  let response;
  try {
    response = await (options.fetchImpl || globalThis.fetch)(request.url, {
      method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: AbortSignal.timeout(provider.timeoutMs)
    });
  } catch (error) {
    if (error.name === 'TimeoutError') throw new AiError(`${provider.label} tardó más de ${Math.round(provider.timeoutMs / 1000)} s en responder.`, 504);
    throw new AiError(`No se pudo conectar con ${provider.label}.`, 502);
  }

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = data?.error?.message || data?.message || '';
    console.warn(`IA ${provider.provider} ${response.status}: ${String(detail).slice(0, 200)}`);
    throw new AiError(explain(response.status, String(detail).slice(0, 200), provider), response.status === 429 ? 429 : 502);
  }

  const text = String(responseText(provider.protocol, data)).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  if (!text) throw new AiError(`${provider.label} devolvió una respuesta vacía.`);
  return { text, provider: provider.provider, label: provider.label, model: provider.model };
}
