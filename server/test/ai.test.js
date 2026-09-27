import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAiModelCatalog } from '../ai-models.js';
import { resolveAi, publicAiInfo, generateEntries, createOpenCodeSessionAllocator, OPENCODE_USER_AGENT } from '../ai.js';
import { tempStore } from './helpers.js';
import { userMessage } from '../prompt.js';
import { generatePreview } from '../ai-workflow.js';

const KEY_ENV = ['AI_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'OPENCODE_API_KEY'];

function isolateKeyEnv(t, values = {}) {
  const saved = new Map(KEY_ENV.map(key => [key, process.env[key]]));
  for (const key of KEY_ENV) delete process.env[key];
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function jsonResponse(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}

function modelSnapshot(provider, models) {
  return {
    providers: [{ id: provider, label: provider, stale: false, models }],
    default: { provider, model: models[0].id },
    fetchedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T00:05:00.000Z', stale: false, errors: []
  };
}

test('loadConfig rechaza adminToken heredado con instrucciones de migración', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'vocab-config-'));
  const configPath = join(dir, 'config.json');
  const savedConfigPath = process.env.VOCAB_CONFIG;
  writeFileSync(configPath, '{"adminToken":"heredado"}');
  process.env.VOCAB_CONFIG = configPath;
  t.after(() => {
    if (savedConfigPath === undefined) delete process.env.VOCAB_CONFIG; else process.env.VOCAB_CONFIG = savedConfigPath;
    rmSync(dir, { recursive: true });
  });
  const { loadConfig } = await import('../config.js?legacy-admin-token');
  await assert.rejects(loadConfig(), /Muévelo a \.env como ADMIN_TOKEN.*elimina adminToken/);
});

test('descubre todos los modelos oficiales de OpenCode Go y no consulta Zen', async t => {
  isolateKeyEnv(t, { OPENCODE_API_KEY: 'go-key' });
  const urls = [];
  const fetchImpl = async url => {
    urls.push(String(url));
    if (String(url) === 'https://models.dev/api.json') return jsonResponse({
      'opencode-go': {
        npm: '@ai-sdk/openai-compatible',
        models: {
          alpha: { name: 'Alpha', family: 'familia-a', provider: { npm: '@ai-sdk/anthropic' } },
          beta: { name: 'Beta', provider: { npm: '@ai-sdk/openai' }, temperature: false }
        }
      },
      opencode: { models: { zen: { name: 'No autorizado' } } }
    });
    return jsonResponse({ object: 'list', data: [{ id: 'alpha' }, { id: 'beta' }, { id: 'official-only' }] });
  };
  const catalog = createAiModelCatalog({ fetchImpl, now: () => 1_000 });
  const snapshot = await catalog.get({ ai: {} });

  assert.deepEqual(snapshot.providers[0].models.map(model => model.id).sort(), ['alpha', 'beta', 'official-only']);
  assert.equal(snapshot.providers[0].models.find(model => model.id === 'alpha').protocol, 'messages');
  assert.equal(snapshot.providers[0].models.find(model => model.id === 'beta').protocol, 'responses');
  assert.equal(snapshot.providers[0].models.find(model => model.id === 'beta').supportsTemperature, false);
  assert.ok(urls.includes('https://opencode.ai/zen/go/v1/models'));
  assert.ok(!urls.includes('https://opencode.ai/zen/v1/models'));
});

test('OpenAI usa su lista oficial y excluye modelos conocidos sin salida de texto', async t => {
  isolateKeyEnv(t, { OPENAI_API_KEY: 'openai-key' });
  const fetchImpl = async url => String(url) === 'https://models.dev/api.json'
    ? jsonResponse({ openai: { npm: '@ai-sdk/openai', models: {
      text: { name: 'Texto', modalities: { output: ['text'] } },
      image: { name: 'Imagen', modalities: { output: ['image'] } }
    } } })
    : jsonResponse({ data: [{ id: 'text' }, { id: 'image' }, { id: 'official-new' }] });
  const snapshot = await createAiModelCatalog({ fetchImpl }).get({ ai: {} });

  assert.deepEqual(snapshot.providers[0].models.map(model => model.id).sort(), ['official-new', 'text']);
  assert.equal(snapshot.providers[0].models.find(model => model.id === 'text').protocol, 'responses');
});

test('Anthropic pagina el catálogo y Gemini conserva solo generateContent', async t => {
  isolateKeyEnv(t, { ANTHROPIC_API_KEY: 'anthropic-key', GEMINI_API_KEY: 'gemini-key' });
  const urls = [];
  const fetchImpl = async (url, options) => {
    const value = String(url); urls.push([value, options.headers]);
    if (value.includes('api.anthropic.com')) {
      return value.includes('after_id=a')
        ? jsonResponse({ data: [{ id: 'b', display_name: 'B' }], has_more: false })
        : jsonResponse({ data: [{ id: 'a', display_name: 'A' }], has_more: true, last_id: 'a' });
    }
    if (value.includes('pageToken=next')) return jsonResponse({ models: [{ name: 'models/gemini-2', displayName: 'Gemini 2', supportedGenerationMethods: ['generateContent'] }] });
    return jsonResponse({
      models: [
        { name: 'models/gemini-1', displayName: 'Gemini 1', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/embed', supportedGenerationMethods: ['embedContent'] }
      ],
      nextPageToken: 'next'
    });
  };
  const snapshot = await createAiModelCatalog({ fetchImpl }).get({ ai: {} });

  assert.deepEqual(snapshot.providers.find(item => item.id === 'anthropic').models.map(model => model.id), ['a', 'b']);
  assert.deepEqual(snapshot.providers.find(item => item.id === 'gemini').models.map(model => model.id), ['gemini-1', 'gemini-2']);
  assert.equal(urls.find(([url]) => url.includes('api.anthropic.com'))[1]['x-api-key'], 'anthropic-key');
  assert.equal(urls.find(([url]) => url.includes('generativelanguage'))[1]['x-goog-api-key'], 'gemini-key');
});

test('oculta un proveedor estándar sin clave aunque permanezca en config', async t => {
  isolateKeyEnv(t);
  let calls = 0;
  const snapshot = await createAiModelCatalog({ fetchImpl: async () => { calls++; return jsonResponse({ data: [{ id: 'unexpected' }] }); } })
    .get({ ai: { providers: { gemini: {} } } });

  assert.deepEqual(snapshot.providers, []);
  assert.deepEqual(snapshot.errors, []);
  assert.equal(calls, 0);
});

test('incluye todos los proveedores estándar que tienen su clave específica', async t => {
  isolateKeyEnv(t, { OPENAI_API_KEY: 'openai-key', ANTHROPIC_API_KEY: 'anthropic-key' });
  const fetchImpl = async url => {
    const value = String(url);
    if (value === 'https://models.dev/api.json') return jsonResponse({});
    if (value.includes('anthropic.com')) return jsonResponse({ data: [{ id: 'claude' }], has_more: false });
    return jsonResponse({ data: [{ id: 'gpt' }] });
  };
  const snapshot = await createAiModelCatalog({ fetchImpl }).get({ ai: {} });

  assert.deepEqual(snapshot.providers.map(provider => provider.id), ['openai', 'anthropic']);
});

test('AI_API_KEY solo activa una configuración explícita no ambigua', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'generic-key' });
  const fetchImpl = async () => jsonResponse({ data: [{ id: 'model' }] });
  const single = await createAiModelCatalog({ fetchImpl }).get({ ai: { providers: { openai: {} } } });
  const absent = await createAiModelCatalog({ fetchImpl }).get({ ai: {} });
  const ambiguous = await createAiModelCatalog({ fetchImpl }).get({ ai: { providers: { openai: {}, anthropic: {} } } });

  assert.deepEqual(single.providers.map(provider => provider.id), ['openai']);
  assert.deepEqual(absent.providers, []);
  assert.deepEqual(ambiguous.providers, []);
});

test('Azure se activa con clave y endpoint raíz, y normaliza su base v1', async t => {
  isolateKeyEnv(t, {
    AZURE_OPENAI_API_KEY: 'azure-key',
    AZURE_OPENAI_ENDPOINT: ' https://resource.openai.azure.com/// '
  });
  let request;
  const snapshot = await createAiModelCatalog({ fetchImpl: async (url, options) => {
    request = { url: String(url), options };
    return jsonResponse({ data: [{ id: 'azure-model' }] });
  } }).get({ ai: {} });

  assert.deepEqual(snapshot.providers.map(provider => provider.id), ['azure']);
  assert.equal(request.url, 'https://resource.openai.azure.com/openai/v1/models');
  assert.equal(request.options.headers['api-key'], 'azure-key');
  assert.equal(request.options.headers.authorization, undefined);
});

test('Azure conserva un endpoint v1 completo sin duplicar la ruta', async t => {
  isolateKeyEnv(t, {
    AZURE_OPENAI_API_KEY: 'azure-key',
    AZURE_OPENAI_ENDPOINT: 'https://resource.services.ai.azure.com/openai/v1/'
  });
  let url;
  await createAiModelCatalog({ fetchImpl: async value => {
    url = String(value);
    return jsonResponse({ data: [{ id: 'azure-model' }] });
  } }).get({ ai: {} });

  assert.equal(url, 'https://resource.services.ai.azure.com/openai/v1/models');
});

test('Azure permanece oculto si falta la clave o el endpoint', async t => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return jsonResponse({ data: [{ id: 'unexpected' }] }); };

  isolateKeyEnv(t, { AZURE_OPENAI_ENDPOINT: 'https://resource.openai.azure.com' });
  const missingKey = await createAiModelCatalog({ fetchImpl }).get({ ai: {} });
  delete process.env.AZURE_OPENAI_ENDPOINT;
  process.env.AZURE_OPENAI_API_KEY = 'azure-key';
  const missingEndpoint = await createAiModelCatalog({ fetchImpl }).get({ ai: { providers: { azure: { baseUrl: 'https://legacy.example/v1' } } } });

  assert.deepEqual(missingKey.providers, []);
  assert.deepEqual(missingEndpoint.providers, []);
  assert.equal(calls, 0);
});

test('Ollama y custom requieren su configuración explícita', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'custom-key' });
  const urls = [];
  const fetchImpl = async url => {
    const value = String(url);
    urls.push(value);
    if (value.includes('/api/tags')) return jsonResponse({ models: [{ name: 'llama-local' }] });
    return jsonResponse({ data: [{ id: 'custom-model' }] });
  };
  const absent = await createAiModelCatalog({ fetchImpl }).get({ ai: {} });
  const explicit = await createAiModelCatalog({ fetchImpl }).get({ ai: { providers: {
    custom: { baseUrl: 'https://custom.example/v1' },
    ollama: {}
  } } });

  assert.deepEqual(absent.providers, []);
  assert.deepEqual(explicit.providers.map(provider => provider.id), ['ollama', 'custom']);
  assert.ok(urls.some(url => url.includes('11434/api/tags')));
});

test('cachea por TTL, deduplica refresh concurrente y conserva stale-if-error', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'key' });
  let now = 1_000;
  let calls = 0;
  let fail = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) await gate;
    if (fail) return jsonResponse({ error: { message: 'https://secret.example token=secret' } }, 500);
    return jsonResponse({ data: [{ id: 'model-a' }] });
  };
  const cfg = { ai: { catalogTtlMs: 100, providers: { custom: { baseUrl: 'https://private.example/v1' } } } };
  const catalog = createAiModelCatalog({ fetchImpl, now: () => now });
  const first = catalog.get(cfg);
  const concurrent = catalog.get(cfg);
  release();
  assert.strictEqual(await first, await concurrent);
  assert.equal(calls, 1);
  await catalog.get(cfg);
  assert.equal(calls, 1);

  now = 1_101; fail = true;
  const stale = await catalog.get(cfg);
  assert.equal(stale.stale, true);
  assert.equal(stale.providers[0].stale, true);
  assert.deepEqual(stale.providers[0].models.map(model => model.id), ['model-a']);
  assert.doesNotMatch(JSON.stringify(stale.errors), /secret|private\.example|token/);
});

test('sin snapshot exitoso omite solo el proveedor fallido y publica error sanitizado', async t => {
  isolateKeyEnv(t, { AZURE_OPENAI_API_KEY: 'azure-key', AZURE_OPENAI_ENDPOINT: 'https://good.example' });
  const snapshot = await createAiModelCatalog({ fetchImpl: async url => {
    if (String(url).includes('bad')) throw new Error('ECONNREFUSED https://bad.internal');
    return jsonResponse({ data: [{ id: 'ok' }] });
  } }).get({ ai: { providers: {
    custom: { baseUrl: 'https://bad.internal', auth: 'none' },
    azure: {}
  } } });

  assert.deepEqual(snapshot.providers.map(provider => provider.id), ['azure']);
  assert.deepEqual(snapshot.errors.map(error => error.provider), ['custom']);
  assert.doesNotMatch(JSON.stringify(snapshot.errors), /bad\.internal|ECONNREFUSED/);
});

test('Azure no expone su clave ni endpoint en respuestas públicas o logs', async t => {
  const apiKey = 'azure-secret-key';
  const endpoint = 'https://private-resource.openai.azure.com';
  isolateKeyEnv(t, { AZURE_OPENAI_API_KEY: apiKey, AZURE_OPENAI_ENDPOINT: endpoint });

  const info = await publicAiInfo({ ai: {} }, {
    catalog: createAiModelCatalog({ fetchImpl: async () => jsonResponse({ error: { message: `${endpoint} ${apiKey}` } }, 400) })
  });
  assert.doesNotMatch(JSON.stringify(info), /azure-secret-key|private-resource/);

  const warnings = [];
  let generationRequest;
  const savedWarn = console.warn;
  console.warn = message => warnings.push(message);
  t.after(() => { console.warn = savedWarn; });
  const snapshot = modelSnapshot('azure', [{ id: 'deployment', label: 'Deployment', protocol: 'chat', supportsTemperature: true }]);
  await assert.rejects(
    generateEntries({ ai: {} }, [{ term: 'word' }], {
      provider: 'azure', model: 'deployment', catalog: { get: async () => snapshot },
      fetchImpl: async (url, options) => {
        generationRequest = { url: String(url), options };
        return jsonResponse({ error: { message: `${endpoint} ${apiKey}` } }, 400);
      }
    }),
    error => {
      assert.doesNotMatch(error.message, /azure-secret-key|private-resource/);
      return true;
    }
  );
  assert.equal(generationRequest.url, `${endpoint}/openai/v1/chat/completions`);
  assert.equal(generationRequest.options.headers['api-key'], apiKey);
  assert.equal(generationRequest.options.headers.authorization, undefined);
  assert.doesNotMatch(warnings.join('\n'), /azure-secret-key|private-resource/);
});

test('publicAiInfo es async y resolveAi valida contra el snapshot descubierto', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'key' });
  const snapshot = modelSnapshot('custom', [{ id: 'allowed', label: 'Permitido', protocol: 'chat', supportsTemperature: true }]);
  const catalog = { get: async () => snapshot };
  const cfg = { ai: { provider: 'custom', model: 'allowed', providers: { custom: { baseUrl: 'https://example.test/v1' } } } };

  const infoPromise = publicAiInfo(cfg, { catalog });
  assert.equal(typeof infoPromise.then, 'function');
  assert.equal((await infoPromise).model, 'allowed');
  assert.equal((await resolveAi(cfg, { provider: 'custom', model: 'allowed' }, { catalog })).enabled, true);
  const rejected = await resolveAi(cfg, { provider: 'custom', model: 'injected' }, { catalog });
  assert.equal(rejected.status, 400);
});

test('la proyección pública excluye ocultos, la administrativa los conserva y generación los rechaza', async t => {
  isolateKeyEnv(t, { AI_API_KEY:'key' });
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const snapshot = modelSnapshot('custom', [
    { id:'visible', label:'Visible', protocol:'chat', supportsTemperature:true },
    { id:'hidden', label:'Hidden', protocol:'chat', supportsTemperature:true }
  ]);
  store.saveAiCuration(snapshot, {
    models:[
      { provider:'custom', model:'visible', visible:true, category:'balanced' },
      { provider:'custom', model:'hidden', visible:false, category:'advanced' }
    ],
    default:{ provider:'custom', model:'visible' }
  });
  const options = { store, catalog:{ get:async () => snapshot } };
  const publicInfo = await publicAiInfo({ ai:{} }, options);
  const adminInfo = await publicAiInfo({ ai:{} }, { ...options, admin:true });
  assert.deepEqual(publicInfo.providers[0].models.map(model => model.id), ['visible']);
  assert.equal(publicInfo.providers[0].models[0].category, 'balanced');
  assert.equal(publicInfo.allProviders, undefined);
  assert.deepEqual(adminInfo.allProviders[0].models.map(model => model.id), ['visible', 'hidden']);
  const hidden = await resolveAi({ ai:{ providers:{ custom:{ baseUrl:'https://example.test/v1' } } } }, { provider:'custom', model:'hidden' }, options);
  assert.equal(hidden.enabled, false);
  assert.equal(hidden.status, 400);
});

test('sin modelos visibles la IA pública queda deshabilitada y sin predeterminado', async t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  const snapshot = modelSnapshot('custom', [{ id:'only', label:'Only', protocol:'chat' }]);
  store.saveAiCuration(snapshot, {
    models:[{ provider:'custom', model:'only', visible:false, category:'unclassified' }],
    default:null
  });
  const info = await publicAiInfo({ ai:{} }, { store, catalog:{ get:async () => snapshot } });
  assert.equal(info.enabled, false);
  assert.equal(info.default, null);
  assert.deepEqual(info.providers, []);
});

test('genera por chat, Messages y Responses con autenticación separada del protocolo', async t => {
  isolateKeyEnv(t, { AI_API_KEY: 'shared-key' });
  const cases = [
    { provider: 'custom', protocol: 'chat', suffix: '/chat/completions', response: { choices: [{ message: { content: '{"entries":[]}' } }] } },
    { provider: 'anthropic', protocol: 'messages', suffix: '/messages', response: { content: [{ type: 'text', text: '{"entries":[]}' }] } },
    { provider: 'openai', protocol: 'responses', suffix: '/responses', response: { output: [{ content: [{ type: 'output_text', text: '{"entries":[]}' }] }] } }
  ];
  for (const item of cases) {
    let request;
    const snapshot = modelSnapshot(item.provider, [{ id: 'model', label: 'Model', protocol: item.protocol, supportsTemperature: true }]);
    const cfg = { ai: { providers: { [item.provider]: { baseUrl: 'https://provider.example/v1' } } } };
    const result = await generateEntries(cfg, [{ term: 'word' }], {
      provider: item.provider,
      model: 'model',
      catalog: { get: async () => snapshot },
      fetchImpl: async (url, options) => { request = { url, options }; return jsonResponse(item.response); }
    });
    assert.equal(result.text, '{"entries":[]}');
    assert.ok(request.url.endsWith(item.suffix));
    if (item.protocol === 'messages') assert.equal(request.options.headers['x-api-key'], 'shared-key');
    else assert.equal(request.options.headers.authorization, 'Bearer shared-key');
  }
});

test('OpenCode Go conserva autenticación y sesión con transporte Messages y omite temperature no soportada', async t => {
  isolateKeyEnv(t, { OPENCODE_API_KEY: 'go-key' });
  let request;
  const snapshot = modelSnapshot('opencode-go', [{ id: 'go-model', label: 'Go', protocol: 'messages', supportsTemperature: false }]);
  await generateEntries(
    { ai: { temperature: 0.4, providers: { 'opencode-go': { baseUrl: 'https://go.example/v1' } } } },
    [{ term: 'word' }],
    {
      provider: 'opencode-go', model: 'go-model', catalog: { get: async () => snapshot },
      allocateOpenCodeSession: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fetchImpl: async (url, options) => { request = { url, options }; return jsonResponse({ content: [{ type: 'text', text: '{"entries":[]}' }] }); }
    }
  );

  assert.equal(request.options.headers['user-agent'], OPENCODE_USER_AGENT);
  assert.equal(request.options.headers['x-opencode-session'], 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.equal(request.options.headers.authorization, 'Bearer go-key');
  assert.equal(request.options.headers['x-api-key'], undefined);
  assert.ok(request.url.endsWith('/messages'));
  assert.equal(JSON.parse(request.options.body).temperature, undefined);
});

test('OpenCode Go rota la sesión antes de la solicitud N+1', () => {
  const ids = ['a', 'b'];
  const allocate = createOpenCodeSessionAllocator(() => ids.shift());
  assert.deepEqual([allocate(2), allocate(2), allocate(2)], ['a', 'a', 'b']);
});

test('construye el mensaje de creación con instrucciones y conserva <<...>> como una unidad', () => {
  const message = userMessage([{ term:'<<Would you mind closing the window?>>', hint:'petición cortés' }], {
    instructions:'Incluye un ejemplo en una oficina.'
  });
  assert.match(message, /LISTA:\n<<Would you mind closing the window\?>> \(petición cortés\)/);
  assert.match(message, /INSTRUCCIONES ADICIONALES:\nIncluye un ejemplo en una oficina\./);
  assert.equal((message.match(/<<Would you mind closing the window\?>>/g) || []).length, 1);

  const editing = userMessage([{ term:'old head' }], {
    instructions:'Cambia el ejemplo.', currentEntry:{ id:'old-head', head:'old head', meaning:'Original' }
  });
  assert.match(editing, /TARJETA ACTUAL \(fuente autoritativa del servidor\):\n\{"id":"old-head"/);
  assert.match(editing, /INSTRUCCIONES ADICIONALES:\nCambia el ejemplo\./);
});

test('la edición usa la tarjeta autoritativa, exige una entrada y conserva proveedor y modelo', async t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  store.apply([{
    name:'prueba',
    text:JSON.stringify({ entries:[{ head:'old head', meaning:'Original', kind:'word' }] })
  }], 'update', 'texto');
  let received;
  const generate = async (cfg, terms, options) => {
    received = { terms, options };
    return {
      provider:options.provider, model:options.model, label:'Modelo de prueba',
      text:JSON.stringify({ entries:[{ head:'new head', meaning:'Editada', kind:'phrase' }] })
    };
  };
  const result = await generatePreview({}, store, {
    entryId:'old-head', instructions:'Amplía el contexto.', provider:'custom', model:'model-x',
    currentEntry:{ head:'falsificada', meaning:'No confiar' }
  }, { edit:true, generate });

  assert.equal(received.options.currentEntry.meaning, 'Original');
  assert.equal(received.options.instructions, 'Amplía el contexto.');
  assert.deepEqual(received.terms, [{ term:'old head', hint:'' }]);
  assert.equal(result.provider, 'custom');
  assert.equal(result.model, 'model-x');
  assert.equal(result.items.length, 1);

  for (const entries of [[], [{ head:'one', meaning:'Uno' }, { head:'two', meaning:'Dos' }]]) {
    await assert.rejects(generatePreview({}, store, {
      entryId:'old-head', provider:'custom', model:'model-x'
    }, { edit:true, generate:async () => ({ provider:'custom', model:'model-x', label:'X', text:JSON.stringify({ entries }) }) }), /exactamente una tarjeta válida/);
  }
});

test('la edición rechaza una selección implícita de proveedor o modelo', async t => {
  const { store, cleanup } = tempStore(); t.after(cleanup);
  await assert.rejects(generatePreview({}, store, { term:'word', provider:'openai' }), /Selecciona explícitamente/);
});
