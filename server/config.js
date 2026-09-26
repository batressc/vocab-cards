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
  trustProxy: false,
  host: '0.0.0.0',
  port: 3000
};

const int = (v, def, min, max) => {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : def;
};
const bool = (v, def) => v === undefined || v === '' ? def : v === true || v === 'true' || v === '1';
const path = p => isAbsolute(p) ? p : resolve(ROOT, p);

/**
 * Lee la configuración no secreta de config.json. Se vuelve a leer en cada
 * petición de administración; los secretos proceden únicamente del entorno.
 * Las variables de entorno tienen prioridad:
 *   VOCAB_DB, VOCAB_DATA_FOLDER, VOCAB_PAGE_SIZE, ADMIN_TOKEN, HOST, PORT, VOCAB_CONFIG
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

  return {
    dbPath: path(String(env.VOCAB_DB || c.dbPath)),
    dataFolderSetting: dataFolder,
    dataFolder: path(dataFolder),
    includeSubfolders: bool(c.includeSubfolders, false),
    seedFromFolderWhenEmpty: bool(c.seedFromFolderWhenEmpty, true),
    adminToken: String(env.ADMIN_TOKEN ?? ''),
    pageSize: int(env.VOCAB_PAGE_SIZE ?? c.pageSize, 12, 1, 200),
    maxPageSize: int(c.maxPageSize, 100, 1, 1000),
    maxImportBytes: int(c.maxImportBytes, DEFAULTS.maxImportBytes, 1024, 50 * 1024 * 1024),
    trustProxy: c.trustProxy ?? false,
    ai: c.ai && typeof c.ai === 'object' ? c.ai : {},
    host: String(env.HOST || c.host),
    port: int(env.PORT ?? c.port, 3000, 1, 65535)
  };
}
