const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const MODELS_DEV_URL = 'https://models.dev/api.json';
const AUTO_KEYED_PROVIDERS = new Set(['opencode-go', 'openai', 'anthropic', 'gemini']);

export const AI_PROVIDERS = Object.freeze({
  'opencode-go': { label: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', keyEnv: 'OPENCODE_API_KEY', protocol: 'chat', jsonMode: false },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', protocol: 'chat' },
  anthropic: { label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', protocol: 'messages', auth: 'x-api-key' },
  gemini: { label: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', protocol: 'chat' },
  azure: { label: 'Azure OpenAI', baseUrl: '', keyEnv: 'AZURE_OPENAI_API_KEY', protocol: 'chat', auth: 'api-key' },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', protocol: 'chat', noKey: true },
  custom: { label: 'Compatible con OpenAI', baseUrl: '', keyEnv: 'AI_API_KEY', protocol: 'chat' }
});

const clean = value => String(value ?? '').trim();
const trimUrl = value => clean(value).replace(/\/+$/, '');
const azureBaseUrl = () => {
  const endpoint = trimUrl(process.env.AZURE_OPENAI_ENDPOINT);
  return endpoint && !/\/openai\/v1$/i.test(endpoint) ? `${endpoint}/openai/v1` : endpoint;
};

function providerEntries(cfg) {
  const providers = cfg.ai?.providers;
  if (!providers || typeof providers !== 'object' || Array.isArray(providers)) return [];
  return Object.entries(providers).flatMap(([rawId, value]) => {
    const id = clean(rawId).toLowerCase();
    if (!id) return [];
    const options = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return [{ id, options }];
  });
}

function specificApiKey(preset) {
  return preset.keyEnv && preset.keyEnv !== 'AI_API_KEY' ? clean(process.env[preset.keyEnv]) : '';
}

// La clave genérica solo es segura si identifica un único proveedor explícito.
function genericKeyProvider(cfg) {
  if (!clean(process.env.AI_API_KEY)) return '';
  const candidates = providerEntries(cfg).filter(({ id, options }) => {
    const preset = AI_PROVIDERS[id];
    const auth = options.auth || preset?.auth || 'bearer';
    return id !== 'azure' && preset && !preset.noKey && auth !== 'none' && !specificApiKey(preset);
  });
  return candidates.length === 1 ? candidates[0].id : '';
}

function activeProviderIds(cfg) {
  const entries = new Map(providerEntries(cfg).map(entry => [entry.id, entry.options]));
  const genericProvider = genericKeyProvider(cfg);
  return Object.entries(AI_PROVIDERS).flatMap(([id, preset]) => {
    const options = entries.get(id);
    const explicit = options !== undefined;
    const hasCredential = Boolean(specificApiKey(preset)) || genericProvider === id;
    if (AUTO_KEYED_PROVIDERS.has(id)) return hasCredential ? [id] : [];
    if (id === 'azure') return specificApiKey(preset) && azureBaseUrl() ? [id] : [];
    if (id === 'custom') return explicit && ((options.auth || preset.auth || 'bearer') === 'none' || hasCredential) ? [id] : [];
    return id === 'ollama' && explicit ? [id] : [];
  });
}

export function resolveProvider(cfg, id) {
  id = clean(id).toLowerCase();
  const preset = AI_PROVIDERS[id];
  const entry = providerEntries(cfg).find(item => item.id === id);
  if (!preset || !activeProviderIds(cfg).includes(id)) return { enabled: false, provider: id, label: preset?.label || id || 'Proveedor desconocido', reason: `El proveedor "${id || 'desconocido'}" no está disponible.` };
  const ai = cfg.ai || {};
  const options = entry?.options || {};
  const apiKey = specificApiKey(preset) || (genericKeyProvider(cfg) === id ? clean(process.env.AI_API_KEY) : '');
  const auth = id === 'azure' ? preset.auth : options.auth || preset.auth || 'bearer';
  const baseUrl = id === 'azure'
    ? azureBaseUrl()
    : trimUrl(options.baseUrl ?? (clean(ai.provider).toLowerCase() === id ? ai.baseUrl : '') ?? preset.baseUrl) || trimUrl(preset.baseUrl);
  if (!baseUrl) return { enabled: false, provider: id, label: preset.label, reason: `Falta "baseUrl" para ${preset.label}.` };
  if (!apiKey && !preset.noKey && auth !== 'none') return { enabled: false, provider: id, label: preset.label, reason: `Falta la clave de API para ${preset.label}.` };
  return {
    enabled: true,
    provider: id,
    label: clean(options.label) || preset.label,
    baseUrl,
    apiKey,
    auth,
    protocol: id === 'azure' ? preset.protocol : options.protocol || preset.protocol,
    jsonMode: options.jsonMode ?? preset.jsonMode ?? true,
    temperature: typeof options.temperature === 'number' ? options.temperature : typeof ai.temperature === 'number' ? ai.temperature : null,
    timeoutMs: positive(options.timeoutMs ?? ai.timeoutMs, 90_000),
    maxTerms: positive(options.maxTerms ?? ai.maxTerms, 10),
    catalogUrl: id === 'azure' ? '' : trimUrl(options.catalogUrl),
    options
  };
}

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function authHeaders(provider, extra = {}) {
  const headers = { accept: 'application/json', ...extra };
  if (!provider.apiKey) return headers;
  if (provider.auth === 'api-key') headers['api-key'] = provider.apiKey;
  else if (provider.auth === 'x-api-key') headers['x-api-key'] = provider.apiKey;
  else headers.authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

async function requestJson(fetchImpl, url, options, timeoutMs) {
  const response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('Respuesta JSON inválida');
  return data;
}

function sanitizeError(provider, error) {
  if (error?.name === 'TimeoutError') return `${provider.label} tardó demasiado en publicar sus modelos.`;
  if (error?.status === 401 || error?.status === 403) return `${provider.label} rechazó la clave al consultar sus modelos.`;
  if (error?.status === 404) return `${provider.label} no ofrece el endpoint de catálogo configurado.`;
  if (error?.status === 429) return `${provider.label} limitó temporalmente la consulta de modelos.`;
  if (error?.status >= 500) return `${provider.label} no pudo publicar sus modelos por un error temporal.`;
  return `No se pudo actualizar el catálogo de ${provider.label}.`;
}

function metadataModel(source, id) {
  if (!source || typeof source !== 'object') return null;
  const models = source.models && typeof source.models === 'object' ? source.models : {};
  return models[id] || Object.values(models).find(model => model?.id === id) || null;
}

function modelProtocol(providerMeta, modelMeta, fallback) {
  const npm = modelMeta?.provider?.npm || providerMeta?.npm || '';
  if (npm === '@ai-sdk/anthropic') return 'messages';
  if (npm === '@ai-sdk/openai') return 'responses';
  if (npm === '@ai-sdk/openai-compatible') return 'chat';
  return fallback;
}

function normalizeModels(rawModels, provider, metadata) {
  const providerMeta = metadata?.[provider.provider];
  const seen = new Set();
  return rawModels.flatMap(raw => {
    const id = clean(raw?.id ?? raw?.name ?? raw);
    if (!id || seen.has(id)) return [];
    const meta = metadataModel(providerMeta, id);
    if (provider.provider === 'openai' && meta && Array.isArray(meta.modalities?.output) && !meta.modalities.output.includes('text')) return [];
    seen.add(id);
    return [{
      id,
      label: clean(meta?.name || raw?.displayName || raw?.display_name || raw?.name || id),
      ...(clean(meta?.family) ? { group: clean(meta.family) } : {}),
      protocol: modelProtocol(providerMeta, meta, provider.protocol),
      supportsTemperature: meta?.temperature !== false
    }];
  }).sort((a, b) => a.label.localeCompare(b.label, 'es', { sensitivity: 'base' }));
}

async function discoverOpenAiList(fetchImpl, provider, url = `${provider.baseUrl}/models`) {
  const extra = provider.provider === 'opencode-go' ? { 'user-agent': 'vocab-cards/1.0.0' } : {};
  const data = await requestJson(fetchImpl, url, { headers: authHeaders(provider, extra) }, provider.timeoutMs);
  if (!Array.isArray(data.data)) throw new Error('Catálogo inválido');
  return data.data;
}

async function discoverAnthropic(fetchImpl, provider) {
  const models = [];
  let afterId = '';
  do {
    const url = new URL(`${provider.baseUrl}/models`);
    url.searchParams.set('limit', '100');
    if (afterId) url.searchParams.set('after_id', afterId);
    const data = await requestJson(fetchImpl, url, {
      headers: { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01', accept: 'application/json' }
    }, provider.timeoutMs);
    if (!Array.isArray(data.data)) throw new Error('Catálogo inválido');
    models.push(...data.data);
    afterId = data.has_more ? clean(data.last_id || data.data.at(-1)?.id) : '';
  } while (afterId);
  return models;
}

async function discoverGemini(fetchImpl, provider) {
  const models = [];
  let pageToken = '';
  do {
    const url = new URL(provider.catalogUrl || 'https://generativelanguage.googleapis.com/v1beta/models');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await requestJson(fetchImpl, url, { headers: { 'x-goog-api-key': provider.apiKey, accept: 'application/json' } }, provider.timeoutMs);
    if (!Array.isArray(data.models)) throw new Error('Catálogo inválido');
    models.push(...data.models.filter(model => model.supportedGenerationMethods?.includes('generateContent')).map(model => ({
      ...model,
      id: clean(model.name).replace(/^models\//, '')
    })));
    pageToken = clean(data.nextPageToken);
  } while (pageToken);
  return models;
}

async function discoverOllama(fetchImpl, provider) {
  const root = provider.baseUrl.replace(/\/v1$/, '');
  const data = await requestJson(fetchImpl, `${root}/api/tags`, { headers: { accept: 'application/json' } }, provider.timeoutMs);
  if (!Array.isArray(data.models)) throw new Error('Catálogo inválido');
  return data.models;
}

async function discoverProvider(fetchImpl, provider, metadata) {
  let raw;
  if (provider.provider === 'anthropic') raw = await discoverAnthropic(fetchImpl, provider);
  else if (provider.provider === 'gemini') raw = await discoverGemini(fetchImpl, provider);
  else if (provider.provider === 'ollama') raw = await discoverOllama(fetchImpl, provider);
  else raw = await discoverOpenAiList(fetchImpl, provider, provider.catalogUrl || `${provider.baseUrl}/models`);
  return normalizeModels(raw, provider, metadata);
}

async function loadMetadata(fetchImpl, providers, timeoutMs) {
  if (!providers.some(provider => provider.provider === 'opencode-go' || provider.provider === 'openai')) return null;
  try {
    return await requestJson(fetchImpl, MODELS_DEV_URL, { headers: { accept: 'application/json' } }, timeoutMs);
  } catch {
    return null;
  }
}

function configSignature(cfg) {
  return JSON.stringify(cfg.ai || {});
}

export function createAiModelCatalog({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  let state = null;
  let inFlight = null;

  async function refresh(cfg) {
    const signature = configSignature(cfg);
    const startedAt = now();
    const configured = activeProviderIds(cfg);
    const timeoutMs = positive(cfg.ai?.catalogTimeoutMs, DEFAULT_TIMEOUT_MS);
    const resolved = configured.map(id => ({ ...resolveProvider(cfg, id), timeoutMs }));
    const metadata = await loadMetadata(fetchImpl, resolved.filter(item => item.enabled), timeoutMs);
    const previous = state?.signature === signature ? state.snapshot : null;
    const settled = await Promise.all(resolved.map(async provider => {
      if (!provider.enabled) return { provider, error: provider.reason };
      try {
        const models = await discoverProvider(fetchImpl, provider, metadata);
        if (!models.length) throw new Error('Catálogo vacío');
        return { provider, models };
      } catch (error) {
        return { provider, error: sanitizeError(provider, error) };
      }
    }));

    const errors = [];
    const providers = settled.flatMap(result => {
      if (result.models) return [{ id: result.provider.provider, label: result.provider.label, models: result.models, stale: false, fetchedAt: new Date(startedAt).toISOString() }];
      errors.push({ provider: result.provider.provider || 'desconocido', message: result.error });
      const old = previous?.providers.find(item => item.id === result.provider.provider);
      return old ? [{ ...old, stale: true }] : [];
    });
    const preferred = { provider: clean(cfg.ai?.provider).toLowerCase(), model: clean(cfg.ai?.model) };
    const hasPreferred = providers.some(item => item.id === preferred.provider && item.models.some(model => model.id === preferred.model));
    const first = providers.find(item => item.models.length);
    const fallback = hasPreferred ? preferred : first ? { provider: first.id, model: first.models[0].id } : null;
    const ttlMs = positive(cfg.ai?.catalogTtlMs, DEFAULT_TTL_MS);
    const snapshot = {
      providers,
      default: fallback,
      fetchedAt: providers.some(provider => provider.stale) && previous?.fetchedAt ? previous.fetchedAt : new Date(startedAt).toISOString(),
      refreshedAt: new Date(startedAt).toISOString(),
      expiresAt: new Date(startedAt + ttlMs).toISOString(),
      stale: providers.some(provider => provider.stale),
      errors
    };
    state = { signature, expiresAt: startedAt + ttlMs, snapshot };
    return snapshot;
  }

  async function get(cfg, { force = false } = {}) {
    const signature = configSignature(cfg);
    if (!force && state?.signature === signature && now() < state.expiresAt) return state.snapshot;
    if (inFlight?.signature === signature) return inFlight.promise;
    const promise = refresh(cfg).finally(() => { if (inFlight?.promise === promise) inFlight = null; });
    inFlight = { signature, promise };
    return promise;
  }

  return { get };
}

export const aiModelCatalog = createAiModelCatalog();

export function findCatalogModel(snapshot, selection) {
  const provider = snapshot?.providers.find(item => item.id === clean(selection?.provider).toLowerCase());
  const model = provider?.models.find(item => item.id === clean(selection?.model));
  return model ? { provider, model } : null;
}
