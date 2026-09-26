/*
 * Conector de IA. Todos los proveedores excepto Anthropic se llaman con el
 * formato de OpenAI (chat/completions), que Google Gemini, Azure OpenAI,
 * Ollama, OpenRouter, Groq y otros aceptan. Sin dependencias: usa fetch.
 */
import { loadSystemPrompt, userMessage } from './prompt.js';

export const PRESETS = {
  gemini:    { label: 'Google Gemini', style: 'openai',    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY',    model: 'gemini-flash-latest' },
  openai:    { label: 'OpenAI',        style: 'openai',    baseUrl: 'https://api.openai.com/v1',                               keyEnv: 'OPENAI_API_KEY',    model: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic',     style: 'anthropic', baseUrl: 'https://api.anthropic.com/v1',                            keyEnv: 'ANTHROPIC_API_KEY', model: 'claude-haiku-4-5-20251001' },
  azure:     { label: 'Azure OpenAI',  style: 'openai',    baseUrl: '',                                                        keyEnv: 'AZURE_OPENAI_API_KEY', auth: 'api-key' },
  'opencode-go': { label: 'OpenCode Go', style: 'openai', baseUrl: 'https://opencode.ai/zen/go/v1', keyEnv: 'OPENCODE_API_KEY', model: 'deepseek-v4-flash', jsonMode: false },
  ollama:    { label: 'Ollama (local)', style: 'openai',   baseUrl: 'http://localhost:11434/v1',                               keyEnv: null,                model: 'llama3.1', noKey: true },
  custom:    { label: 'Compatible con OpenAI', style: 'openai', baseUrl: '',                                                   keyEnv: 'AI_API_KEY' }
};

/** Resuelve la configuración efectiva. La clave viene de AI_API_KEY o de la variable específica del proveedor. */
export function resolveAi(cfg) {
  const ai = cfg.ai || {};
  const name = String(ai.provider || '').toLowerCase();
  const preset = PRESETS[name];
  if (!preset) return { enabled: false, reason: name ? `Proveedor "${name}" desconocido.` : 'No hay proveedor de IA configurado.' };

  const env = process.env;
  const apiKey = env.AI_API_KEY || (preset.keyEnv && env[preset.keyEnv]) || '';
  const baseUrl = String(ai.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  const model = String(ai.model || preset.model || '');
  const r = {
    enabled: true, provider: name, label: preset.label, style: preset.style, baseUrl, model, apiKey,
    auth: ai.auth || preset.auth || 'bearer',
    jsonMode: ai.jsonMode ?? preset.jsonMode ?? true,
    temperature: typeof ai.temperature === 'number' ? ai.temperature : null,
    timeoutMs: Number(ai.timeoutMs) > 0 ? Number(ai.timeoutMs) : 90_000,
    maxTerms: Number(ai.maxTerms) > 0 ? Number(ai.maxTerms) : 10
  };
  if (!baseUrl) return { enabled: false, reason: `Falta "ai.baseUrl" para ${preset.label}.` };
  if (!model) return { enabled: false, reason: 'Falta "ai.model".' };
  if (!apiKey && !preset.noKey) return { enabled: false, reason: `Falta la clave de API (${preset.keyEnv || 'AI_API_KEY'} o AI_API_KEY).` };
  return r;
}

/** Información pública (sin la clave) para el navegador. */
export function publicAiInfo(cfg) {
  const r = resolveAi(cfg);
  return r.enabled ? { enabled: true, provider: r.provider, label: r.label, model: r.model } : { enabled: false, reason: r.reason };
}

class AiError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

function explain(status, detail, r) {
  if (status === 401 || status === 403) return `${r.label} rechazó la clave de API. Revísala en la configuración.`;
  if (status === 404) return `${r.label} no encontró el modelo "${r.model}" o la dirección configurada.`;
  if (status === 429) return `${r.label} indica que se alcanzó el límite de uso o la cuota. Espera un momento o revisa tu plan.`;
  if (status >= 500) return `${r.label} tuvo un error temporal (${status}). Inténtalo de nuevo.`;
  return `${r.label} respondió ${status}${detail ? `: ${detail}` : '.'}`;
}

/** Pide a la IA las entradas para los términos dados. Devuelve el texto de la respuesta. */
export async function generateEntries(cfg, terms) {
  const r = resolveAi(cfg);
  if (!r.enabled) throw new AiError(r.reason, 503);

  const system = await loadSystemPrompt(cfg);
  const user = userMessage(terms);
  let url, headers, body;

  if (r.style === 'anthropic') {
    url = `${r.baseUrl}/messages`;
    headers = { 'content-type': 'application/json', 'x-api-key': r.apiKey, 'anthropic-version': '2023-06-01' };
    body = { model: r.model, max_tokens: 1500 * Math.max(1, terms.length) + 500, system, messages: [{ role: 'user', content: user }] };
    if (r.temperature !== null) body.temperature = r.temperature;
  } else {
    url = `${r.baseUrl}/chat/completions`;
    headers = { 'content-type': 'application/json' };
    if (r.apiKey) {
      if (r.auth === 'api-key') headers['api-key'] = r.apiKey;
      else headers.authorization = `Bearer ${r.apiKey}`;
    }
    body = { model: r.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
    if (r.jsonMode) body.response_format = { type: 'json_object' };
    if (r.temperature !== null) body.temperature = r.temperature;
  }

  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(r.timeoutMs) });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new AiError(`${r.label} tardó más de ${Math.round(r.timeoutMs / 1000)} s en responder.`, 504);
    throw new AiError(`No se pudo conectar con ${r.label} (${err.cause?.code || err.message}).`, 502);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = data?.error?.message || data?.message || '';
    console.warn(`IA ${r.provider} ${res.status}: ${detail}`);
    throw new AiError(explain(res.status, String(detail).slice(0, 200), r), res.status === 429 ? 429 : 502);
  }

  let text = r.style === 'anthropic'
    ? (data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
    : data?.choices?.[0]?.message?.content ?? '';
  // Algunos modelos de razonamiento incluyen su "pensamiento" en el texto: se descarta.
  text = String(text).replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  if (!text.trim()) throw new AiError(`${r.label} devolvió una respuesta vacía.`);
  return { text, provider: r.provider, label: r.label, model: r.model };
}
