import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute } from 'node:path';

export const ROOT = resolve(import.meta.dirname, '..');
const CONFIG_PATH = resolve(ROOT, process.env.VOCAB_CONFIG || 'config.json');

const DEFAULTS = {
  dbPath: 'data/vocab.db',
  dataFolder: 'data/seed',
  includeSubfolders: false,
  seedFromFolderWhenEmpty: true,
  pageSize: 12,
  maxPageSize: 100,
  maxImportBytes: 5 * 1024 * 1024,
  maxBackupBytes: 64 * 1024 * 1024,
  trustProxy: false,
  host: '0.0.0.0',
  port: 3000
};
const AI_DEFAULTS = {
  timeoutMs: 90_000,
  catalogTtlMs: 300_000,
  catalogTimeoutMs: 10_000,
  maxTerms: 10
};

const int = (v, def, min, max) => {
  const n = typeof v === 'number'
    ? v
    : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : def;
};
const bool = (v, def) => v === undefined || v === '' ? def : v === true || v === 'true' || v === '1';
const path = p => isAbsolute(p) ? p : resolve(ROOT, p);

function envInt(env, name, fileValue, defaultValue, min, max) {
  const fileFallback = int(fileValue, defaultValue, min, max);
  return int(env[name], fileFallback, min, max);
}

function envBool(env, name, fallback) {
  if (env[name] === undefined) return bool(fallback, fallback);
  if (env[name] === 'true' || env[name] === '1') return true;
  if (env[name] === 'false' || env[name] === '0') return false;
  throw new Error(`${name} debe ser true, false, 1 o 0.`);
}

function envTrustProxy(env, fallback) {
  if (env.VOCAB_TRUST_PROXY === undefined) return fallback ?? false;
  if (/^\d+$/.test(env.VOCAB_TRUST_PROXY)) return int(env.VOCAB_TRUST_PROXY, fallback, 0, 100);
  return envBool(env, 'VOCAB_TRUST_PROXY', fallback);
}

/**
 * Lee la configuración no secreta de config.json. Se vuelve a leer en cada
 * petición de administración; los secretos proceden del entorno o del archivo
 * de credenciales dedicado.
 * Las variables de entorno tienen prioridad:
 * Las estructuras complejas se mantienen en VOCAB_CONFIG; el entorno solo
 * sobrescribe escalares operativos tipados.
 */
export async function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn(`No se pudo leer ${CONFIG_PATH}: ${err.message}. Se usan valores por defecto.`);
  }
  if (Object.hasOwn(file, 'adminToken')) {
    throw new Error('config.json contiene adminToken heredado. Muévelo a .env como ADMIN_TOKEN y elimina adminToken de config.json.');
  }
  const env = process.env;
  const c = { ...DEFAULTS, ...file };
  const dataFolder = String(env.VOCAB_DATA_FOLDER || c.dataFolder);
  const fileAi = c.ai && typeof c.ai === 'object' && !Array.isArray(c.ai) ? c.ai : {};
  const ai = {
    ...fileAi,
    timeoutMs: envInt(env, 'AI_TIMEOUT_MS', fileAi.timeoutMs, AI_DEFAULTS.timeoutMs, 1_000, 600_000),
    catalogTtlMs: envInt(env, 'AI_CATALOG_TTL_MS', fileAi.catalogTtlMs, AI_DEFAULTS.catalogTtlMs, 1_000, 86_400_000),
    catalogTimeoutMs: envInt(env, 'AI_CATALOG_TIMEOUT_MS', fileAi.catalogTimeoutMs, AI_DEFAULTS.catalogTimeoutMs, 1_000, 120_000),
    maxTerms: envInt(env, 'AI_MAX_TERMS', fileAi.maxTerms, AI_DEFAULTS.maxTerms, 1, 100)
  };

  return {
    dbPath: path(String(env.VOCAB_DB || c.dbPath)),
    dataFolderSetting: dataFolder,
    dataFolder: path(dataFolder),
    includeSubfolders: envBool(env, 'VOCAB_INCLUDE_SUBFOLDERS', c.includeSubfolders),
    seedFromFolderWhenEmpty: envBool(env, 'VOCAB_SEED_FROM_FOLDER_WHEN_EMPTY', c.seedFromFolderWhenEmpty),
    adminToken: String(env.ADMIN_TOKEN ?? ''),
    pageSize: envInt(env, 'VOCAB_PAGE_SIZE', c.pageSize, DEFAULTS.pageSize, 1, 200),
    maxPageSize: envInt(env, 'VOCAB_MAX_PAGE_SIZE', c.maxPageSize, DEFAULTS.maxPageSize, 1, 1000),
    maxImportBytes: envInt(env, 'VOCAB_MAX_IMPORT_BYTES', c.maxImportBytes, DEFAULTS.maxImportBytes, 1024, 50 * 1024 * 1024),
    maxBackupBytes: envInt(env, 'VOCAB_MAX_BACKUP_BYTES', c.maxBackupBytes, DEFAULTS.maxBackupBytes, 1024 * 1024, 512 * 1024 * 1024),
    trustProxy: envTrustProxy(env, c.trustProxy),
    ai,
    host: String(env.HOST || c.host),
    port: envInt(env, 'PORT', c.port, DEFAULTS.port, 1, 65535)
  };
}
