import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { ROOT, loadConfig } from './config.js';
import { VocabStore, normalizeGenerationId, readFolderSources } from './vocab-store.js';
import { createAuth } from './auth.js';
import { publicAiInfo, OPENCODE_SESSION_LIMIT } from './ai.js';
import { aiModelCatalog } from './ai-models.js';
import { generatePreview } from './ai-workflow.js';
import { normalizeTelemetryBatch } from './telemetry.js';
import { validateBackupDatabase } from './db.js';

// --dev: Vite sirve el frontend con recarga en caliente. Sin --dev: se sirve dist/ (npm run build).
const DEV = process.argv.includes('--dev');
const DIST = resolve(ROOT, 'dist');

const boot = await loadConfig();
const store = new VocabStore(boot.dbPath);
const auth = createAuth(loadConfig);

// Primera vez: si la base de datos está vacía, importa la carpeta de ejemplo.
if (store.size === 0 && boot.seedFromFolderWhenEmpty && store.shouldSeedWhenEmpty()) {
  const r = store.apply(await readFolderSources(boot), 'keep', 'carpeta');
  if (r.summary.new) console.log(`Base de datos inicial: ${r.summary.new} registros importados de ${boot.dataFolderSetting}.`);
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', boot.trustProxy);

const json = limit => express.json({ limit });
const binary = limit => express.raw({ type: ['application/vnd.sqlite3', 'application/octet-stream'], limit });
const writeLimiter = rateLimit({
  windowMs: 60_000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Demasiadas operaciones seguidas; espera un minuto.' }
});
const telemetryLimiter = rateLimit({
  windowMs:60_000, limit:120, standardHeaders:'draft-8', legacyHeaders:false,
  message:{ error:'Demasiados eventos de uso seguidos; espera un minuto.' }
});
const maintenanceLimiter = rateLimit({
  windowMs:60 * 60_000, limit:5, standardHeaders:'draft-8', legacyHeaders:false,
  message:{ error:'Demasiadas operaciones de mantenimiento; espera antes de volver a intentarlo.' }
});
const asMode = v => v === 'keep' ? 'keep' : 'update';

/* ------------------------------------------------------- lectura (pública) */
const vocab = express.Router();

vocab.get('/meta', async (req, res) => {
  const cfg = await loadConfig();
  res.json({ ...store.meta(cfg.pageSize), ai: await publicAiInfo(cfg, { store }) });
});

vocab.post('/query', json('64kb'), async (req, res) => res.json(store.query(req.body ?? {}, await loadConfig())));

vocab.get('/export', (req, res) => {
  const stamp = new Date().toISOString().slice(0, 10);
  res.attachment(`vocab-respaldo-${stamp}.json`).json(store.exportAll());
});

vocab.delete('/entries/:id', writeLimiter, auth.require, (req, res) => {
  if (!store.remove(req.params.id)) return res.status(404).json({ error: 'La tarjeta no existe.' });
  res.json({ ok: true, total: store.size });
});

app.use('/api/vocab', vocab);

app.post('/api/telemetry/events', json('32kb'), telemetryLimiter, (req, res) => {
  try {
    const batch = normalizeTelemetryBatch(req.body);
    res.status(202).json({ ok:true, ...store.recordUsage(batch) });
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error:err.message });
    throw err;
  }
});

/* ------------------------------------------------ administración (con clave) */
const admin = express.Router();
admin.use(writeLimiter, auth.require);

// Para que la pantalla de carga valide la clave antes de trabajar.
admin.get('/check', async (req, res) => {
  const cfg = await loadConfig();
  res.json({
    ok: true,
    total: store.size,
    dataFolder: cfg.dataFolderSetting,
    maxImportBytes: cfg.maxImportBytes,
    maxBackupBytes: cfg.maxBackupBytes,
    ai: await publicAiInfo(cfg, { store, admin: true }),
    opencodeSessionLimit: OPENCODE_SESSION_LIMIT
  });
});

// Texto pegado o archivos subidos: { sources: [{ name, text }], mode, dryRun }
admin.post('/import', async (req, res, next) => json((await loadConfig()).maxImportBytes + 64 * 1024)(req, res, next), (req, res) => {
  try {
    const { sources, mode, dryRun, origin } = req.body ?? {};
    const generationId = normalizeGenerationId(req.body?.generationId);
    if (!Array.isArray(sources) || !sources.length) return res.status(400).json({ error: 'No se recibió contenido para importar.' });
    const clean = sources.slice(0, 50).map((s, i) => ({
      name: String(s?.name || `Texto ${i + 1}`).slice(0, 120),
      text: typeof s?.text === 'string' ? s.text : '',
      error: typeof s?.text === 'string' && s.text.trim() ? undefined : 'está vacío.'
    }));
    const originName = ['archivo', 'ia'].includes(origin) ? origin : 'texto';
    res.json(dryRun ? store.plan(clean, asMode(mode)) : store.apply(clean, asMode(mode), originName, generationId ? { generationId } : {}));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error:err.message, code:err.code });
    throw err;
  }
});

// Importa los .json de la carpeta configurada en el servidor: { mode, dryRun }
admin.post('/import-folder', json('4kb'), async (req, res) => {
  const cfg = await loadConfig();
  const sources = await readFolderSources(cfg);
  if (!sources.length) return res.json({ items: [], summary: { new: 0, update: 0, same: 0, skip: 0, duplicate: 0, error: 0 }, empty: true });
  const mode = asMode(req.body?.mode);
  res.json(req.body?.dryRun ? store.plan(sources, mode) : store.apply(sources, mode, 'carpeta'));
});

admin.get('/imports', (req, res) => res.json(store.history(15)));

admin.get('/statistics', (req, res) => {
  try { res.json(store.statistics(req.query.range || '30d')); }
  catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error:err.message });
    throw err;
  }
});

admin.get('/maintenance/summary', (req, res) => res.json(store.maintenanceSummary()));

// El respaldo SQLite conserva tablas de métricas, auditoría y preferencias, a
// diferencia de la exportación JSON, que solo representa tarjetas.
admin.get('/backup', maintenanceLimiter, async (req, res, next) => {
  let dir;
  try {
    dir = await mkdtemp(resolve(tmpdir(), 'vocab-cards-backup-'));
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = resolve(dir, `vocab-cards-${stamp}.sqlite`);
    await store.backup(file);
    res.set('Cache-Control', 'no-store');
    res.download(file, `vocab-cards-${stamp}.sqlite`, err => {
      rm(dir, { recursive: true, force: true }).catch(() => {});
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    next(err);
  }
});

const RESTORE_CONFIRMATION = 'RESTAURAR BASE DE DATOS';
admin.post('/backup/restore', maintenanceLimiter, async (req, res, next) => {
  const cfg = await loadConfig();
  binary(cfg.maxBackupBytes)(req, res, next);
}, async (req, res) => {
  if (req.get('x-backup-confirmation') !== RESTORE_CONFIRMATION) {
    return res.status(400).json({ error: 'La frase de confirmación no coincide con la restauración.' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ error: 'No se recibió un archivo SQLite para restaurar.' });
  }

  let dir;
  let file;
  try {
    // boot.dbPath es la base que este proceso abrió; la configuración puede
    // cambiar en disco sin mover la conexión activa hasta el próximo arranque.
    dir = await mkdtemp(join(dirname(boot.dbPath), '.vocab-cards-restore-'));
    file = resolve(dir, 'uploaded.sqlite');
    await writeFile(file, req.body, { flag: 'wx' });
    validateBackupDatabase(file);
    await store.restoreBackup(file);
    file = null; // restoreBackup movió el archivo al dbPath configurado.
    res.json({ ok:true, total:store.size });
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error:err.message });
    console.error(err);
    res.status(500).json({ error:err.message || 'No se pudo restaurar el respaldo.' });
  } finally {
    if (file) await rm(file, { force: true }).catch(() => {});
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

const CLEAR_PHRASES = {
  cards:'ELIMINAR TARJETAS', audit:'LIMPIAR AUDITORÍA', metrics:'LIMPIAR MÉTRICAS', all:'REINICIAR TODO'
};
admin.post('/maintenance/clear', maintenanceLimiter, json('4kb'), (req, res) => {
  const scope = req.body?.scope;
  if (!Object.hasOwn(CLEAR_PHRASES, scope) || req.body?.confirmation !== CLEAR_PHRASES[scope]) {
    return res.status(400).json({ error:'La frase de confirmación no coincide con la operación solicitada.' });
  }
  res.json({ ok:true, ...store.clearMaintenance(scope) });
});

admin.get('/entries/:id', (req, res) => {
  const entry = store.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'La tarjeta no existe.' });
  res.json(entry);
});

admin.put('/entries/:id', json('16kb'), (req, res) => {
  try {
    const generationId = normalizeGenerationId(req.body?.generationId);
    res.json({ ok:true, ...store.replace(req.params.id, req.body?.entry, req.body?.source, generationId ? { generationId } : {}) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message, code: err.code });
    throw err;
  }
});

admin.delete('/entries/:id', (req, res) => {
  if (!store.remove(req.params.id)) return res.status(404).json({ error: 'La tarjeta no existe.' });
  res.json({ ok: true, total: store.size });
});

admin.post('/ai/models/refresh', async (req, res) => {
  const cfg = await loadConfig();
  res.json(await publicAiInfo(cfg, { force: true, store, admin: true }));
});

admin.put('/ai/curation', json('256kb'), async (req, res) => {
  try {
    const cfg = await loadConfig();
    const snapshot = await aiModelCatalog.get(cfg);
    store.saveAiCuration(snapshot, req.body);
    res.json(await publicAiInfo(cfg, { store, admin: true, catalog: { get: async () => snapshot } }));
  } catch (err) {
    if (err instanceof TypeError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

// Genera la tarjeta de una palabra o frase con la IA configurada. No guarda nada:
// devuelve la vista previa y el texto, que se guarda después con /import.
const aiLimiter = rateLimit({
  windowMs: 60_000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Demasiadas generaciones seguidas; espera un minuto.' }
});
admin.post('/ai/generate', aiLimiter, json('8kb'), async (req, res) => {
  try {
    const cfg = await loadConfig();
    res.json(await generatePreview(cfg, store, req.body));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

admin.post('/ai/edit', aiLimiter, json('16kb'), async (req, res) => {
  try {
    res.json(await generatePreview(await loadConfig(), store, req.body, { edit: true }));
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    throw err;
  }
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada.' }));

/* -------------------------------------------------------------- frontend */
if (DEV) {
  // La config se importa directo con configFile: false. Si Vite carga un archivo de
  // configuración, lo empaqueta en node_modules/.vite-temp/vite.config.js.timestamp-*.mjs,
  // lo importa y lo borra en el arranque; node --watch ve ese cambio y reinicia, y cada
  // reinicio escribe un temporal nuevo: ciclo infinito. Así no se genera ningún temporal.
  const { createServer } = await import('vite');
  const { default: viteConfig } = await import('../vite.config.js');
  const inline = typeof viteConfig === 'function'
    ? await viteConfig({ command: 'serve', mode: 'development' })
    : viteConfig;
  const vite = await createServer({
    ...inline,
    configFile: false,
    server: { ...inline.server, middlewareMode: true },
    appType: 'mpa'
  });
  app.use(vite.middlewares);
} else {
  if (!existsSync(resolve(DIST, 'index.html'))) {
    console.error('No existe dist/. Ejecuta "npm run build" antes de "npm start", o usa "npm run dev".');
    process.exit(1);
  }
  // Los archivos con hash en el nombre se pueden cachear mucho tiempo; el HTML no.
  app.use('/assets', express.static(resolve(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(DIST, { extensions: ['html'], maxAge: 0 }));
}

/* -------------------------------------------------------------- errores */
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: req.path.includes('/backup/restore')
    ? 'El respaldo supera el límite permitido. Reduce el archivo o sube maxBackupBytes en config.json.'
    : 'El contenido es demasiado grande. Divídelo en partes o sube maxImportBytes en config.json.' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'La petición no es JSON válido.' });
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

/* -------------------------------------------------------------- arranque */
const server = app.listen(boot.port, boot.host, async () => {
  console.log(`Tarjetas de inglés en http://${boot.host === '0.0.0.0' ? 'localhost' : boot.host}:${boot.port}`);
  console.log(`Base de datos: ${boot.dbPath} (${store.size} registros)`);
  console.log(DEV ? 'Modo desarrollo: Vite con recarga en caliente.' : `Sirviendo ${DIST}`);
  await auth.announce();
});

const shutdown = () => server.close(() => { store.close(); process.exit(0); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
