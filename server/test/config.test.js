import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_NAMES = [
  'VOCAB_CONFIG', 'VOCAB_INCLUDE_SUBFOLDERS', 'VOCAB_SEED_FROM_FOLDER_WHEN_EMPTY',
  'VOCAB_PAGE_SIZE', 'VOCAB_MAX_PAGE_SIZE', 'VOCAB_MAX_IMPORT_BYTES',
  'VOCAB_MAX_BACKUP_BYTES', 'VOCAB_TRUST_PROXY', 'AI_TIMEOUT_MS',
  'AI_CATALOG_TTL_MS', 'AI_CATALOG_TIMEOUT_MS', 'AI_MAX_TERMS', 'PORT'
];

function isolateEnv(t) {
  const saved = new Map(ENV_NAMES.map(name => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  t.after(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

test('los escalares del entorno tienen precedencia y conservan tipos', async t => {
  isolateEnv(t);
  const dir = mkdtempSync(join(tmpdir(), 'vocab-config-env-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify({ pageSize: 5, trustProxy: false, ai: { timeoutMs: 2_000 } }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  Object.assign(process.env, {
    VOCAB_CONFIG: path,
    VOCAB_INCLUDE_SUBFOLDERS: 'true',
    VOCAB_SEED_FROM_FOLDER_WHEN_EMPTY: '0',
    VOCAB_PAGE_SIZE: '24',
    VOCAB_MAX_PAGE_SIZE: '250',
    VOCAB_MAX_IMPORT_BYTES: '1048576',
    VOCAB_MAX_BACKUP_BYTES: '8388608',
    VOCAB_TRUST_PROXY: '1',
    AI_TIMEOUT_MS: '45000',
    AI_CATALOG_TTL_MS: '60000',
    AI_CATALOG_TIMEOUT_MS: '5000',
    AI_MAX_TERMS: '20',
    PORT: '3100'
  });
  const { loadConfig } = await import(`../config.js?typed-env-${Date.now()}`);
  const cfg = await loadConfig();

  assert.equal(cfg.includeSubfolders, true);
  assert.equal(cfg.seedFromFolderWhenEmpty, false);
  assert.equal(cfg.pageSize, 24);
  assert.equal(cfg.maxPageSize, 250);
  assert.equal(cfg.maxImportBytes, 1_048_576);
  assert.equal(cfg.maxBackupBytes, 8_388_608);
  assert.equal(cfg.trustProxy, 1);
  assert.equal(cfg.ai.timeoutMs, 45_000);
  assert.equal(cfg.ai.catalogTtlMs, 60_000);
  assert.equal(cfg.ai.catalogTimeoutMs, 5_000);
  assert.equal(cfg.ai.maxTerms, 20);
  assert.equal(cfg.port, 3100);
});

const INTEGER_DEFAULTS = {
  pageSize: 12,
  maxPageSize: 100,
  maxImportBytes: 5 * 1024 * 1024,
  maxBackupBytes: 64 * 1024 * 1024,
  port: 3000,
  ai: { timeoutMs: 90_000, catalogTtlMs: 300_000, catalogTimeoutMs: 10_000, maxTerms: 10 }
};

function integerConfig(value) {
  return {
    pageSize: value,
    maxPageSize: value,
    maxImportBytes: value,
    maxBackupBytes: value,
    port: value,
    ai: { timeoutMs: value, catalogTtlMs: value, catalogTimeoutMs: value, maxTerms: value }
  };
}

function assertIntegerConfig(cfg, expected) {
  for (const name of ['pageSize', 'maxPageSize', 'maxImportBytes', 'maxBackupBytes', 'port']) {
    assert.equal(cfg[name], expected[name], name);
  }
  for (const name of ['timeoutMs', 'catalogTtlMs', 'catalogTimeoutMs', 'maxTerms']) {
    assert.equal(cfg.ai[name], expected.ai[name], `ai.${name}`);
  }
}

test('JSON inválido, null o fuera de rango cae a defaults enteros tipados', async t => {
  isolateEnv(t);
  const dir = mkdtempSync(join(tmpdir(), 'vocab-config-invalid-json-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [index, value] of ['incorrecto', null, 0].entries()) {
    const path = join(dir, `config-${index}.json`);
    writeFileSync(path, JSON.stringify(integerConfig(value)));
    process.env.VOCAB_CONFIG = path;
    const { loadConfig } = await import(`../config.js?invalid-json-${index}-${Date.now()}`);
    assertIntegerConfig(await loadConfig(), INTEGER_DEFAULTS);
  }
});

test('entorno inválido cae a JSON validado y después al default real', async t => {
  isolateEnv(t);
  const dir = mkdtempSync(join(tmpdir(), 'vocab-config-layered-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  Object.assign(process.env, {
    VOCAB_PAGE_SIZE: 'incorrecto',
    VOCAB_MAX_PAGE_SIZE: '-1',
    VOCAB_MAX_IMPORT_BYTES: '999999999',
    VOCAB_MAX_BACKUP_BYTES: '1.5',
    PORT: '70000',
    AI_TIMEOUT_MS: 'NaN',
    AI_CATALOG_TTL_MS: '0',
    AI_CATALOG_TIMEOUT_MS: '999999',
    AI_MAX_TERMS: '101'
  });

  const valid = {
    pageSize: 20, maxPageSize: 300, maxImportBytes: 2_000_000,
    maxBackupBytes: 80_000_000, port: 4000,
    ai: { timeoutMs: 40_000, catalogTtlMs: 60_000, catalogTimeoutMs: 5_000, maxTerms: 25 }
  };
  const validPath = join(dir, 'valid.json');
  writeFileSync(validPath, JSON.stringify(valid));
  process.env.VOCAB_CONFIG = validPath;
  const validModule = await import(`../config.js?invalid-env-valid-json-${Date.now()}`);
  assertIntegerConfig(await validModule.loadConfig(), valid);

  const invalidPath = join(dir, 'invalid.json');
  writeFileSync(invalidPath, JSON.stringify(integerConfig(null)));
  process.env.VOCAB_CONFIG = invalidPath;
  const invalidModule = await import(`../config.js?invalid-env-invalid-json-${Date.now()}`);
  assertIntegerConfig(await invalidModule.loadConfig(), INTEGER_DEFAULTS);
});
