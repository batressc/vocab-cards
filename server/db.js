import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/* SQLite integrado en Node (node:sqlite, Node 22.13+): no requiere compilar nada. */

/* Migraciones: cada elemento sube PRAGMA user_version en 1. */
const MIGRATIONS = [
  `
  CREATE TABLE entries (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,   -- orden de inserción (desempate)
    id          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    data        TEXT    NOT NULL,                    -- entrada normalizada en JSON
    added_at    TEXT    NOT NULL,                    -- ISO 8601
    updated_at  TEXT    NOT NULL,
    source      TEXT                                 -- archivo o "Texto pegado"
  );

  CREATE TABLE imports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  TEXT    NOT NULL,
    origin      TEXT    NOT NULL,                    -- texto | archivo | carpeta
    sources     TEXT    NOT NULL,                    -- nombres separados por coma
    mode        TEXT    NOT NULL,                    -- update | keep
    inserted    INTEGER NOT NULL DEFAULT 0,
    updated     INTEGER NOT NULL DEFAULT 0,
    unchanged   INTEGER NOT NULL DEFAULT 0,
    skipped     INTEGER NOT NULL DEFAULT 0,
    errors      INTEGER NOT NULL DEFAULT 0
  );
  `,
  `
  CREATE TABLE ai_model_preferences (
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    visible     INTEGER NOT NULL CHECK (visible IN (0, 1)),
    category    TEXT NOT NULL CHECK (category IN ('unclassified', 'efficient', 'balanced', 'advanced')),
    PRIMARY KEY (provider, model)
  );

  CREATE TABLE ai_settings (
    id                INTEGER PRIMARY KEY CHECK (id = 1),
    default_provider  TEXT,
    default_model     TEXT,
    CHECK ((default_provider IS NULL) = (default_model IS NULL))
  );

  INSERT INTO ai_settings (id, default_provider, default_model) VALUES (1, NULL, NULL);
  `
];

export function openDatabase(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

  /** Ejecuta fn dentro de una transacción; si lanza un error, deshace todo. */
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }

  const sql = {
    all:        db.prepare('SELECT seq, id, data, added_at, updated_at, source FROM entries ORDER BY seq'),
    insert:     db.prepare('INSERT INTO entries (id, data, added_at, updated_at, source) VALUES (@id, @data, @addedAt, @now, @source)'),
    update:     db.prepare('UPDATE entries SET data = @data, updated_at = @now, source = @source, added_at = COALESCE(@addedAt, added_at) WHERE id = @id'),
    replaceById: db.prepare('UPDATE entries SET id = @nextId, data = @data, updated_at = @now, source = @source WHERE id = @originalId'),
    remove:     db.prepare('DELETE FROM entries WHERE id = ?'),
    logImport:  db.prepare(`INSERT INTO imports (created_at, origin, sources, mode, inserted, updated, unchanged, skipped, errors)
                            VALUES (@createdAt, @origin, @sources, @mode, @inserted, @updated, @unchanged, @skipped, @errors)`),
    history:    db.prepare('SELECT * FROM imports ORDER BY id DESC LIMIT ?'),
    aiPreferences: db.prepare('SELECT provider, model, visible, category FROM ai_model_preferences'),
    aiDefault: db.prepare('SELECT default_provider, default_model FROM ai_settings WHERE id = 1'),
    upsertAiPreference: db.prepare(`INSERT INTO ai_model_preferences (provider, model, visible, category)
                                    VALUES (@provider, @model, @visible, @category)
                                    ON CONFLICT(provider, model) DO UPDATE SET visible = excluded.visible, category = excluded.category`),
    updateAiDefault: db.prepare('UPDATE ai_settings SET default_provider = @provider, default_model = @model WHERE id = 1')
  };

  return { db, sql, transaction, close: () => db.close() };
}
