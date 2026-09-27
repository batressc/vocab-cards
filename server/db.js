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
  `,
  `
  CREATE TABLE app_state (
    id                       INTEGER PRIMARY KEY CHECK (id = 1),
    suppress_seed_when_empty INTEGER NOT NULL DEFAULT 0 CHECK (suppress_seed_when_empty IN (0, 1)),
    data_epoch               INTEGER NOT NULL DEFAULT 0 CHECK (data_epoch >= 0)
  );
  INSERT INTO app_state (id) VALUES (1);

  CREATE TABLE usage_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at   TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    session_id   TEXT NOT NULL,
    event_type   TEXT NOT NULL CHECK (event_type IN ('search', 'card_view', 'card_flip', 'audio_play', 'known_changed', 'practice_changed')),
    entry_id     TEXT,
    term         TEXT,
    result_count INTEGER CHECK (result_count IS NULL OR result_count >= 0),
    value        INTEGER CHECK (value IS NULL OR value IN (0, 1))
  );
  CREATE INDEX usage_events_created_idx ON usage_events(created_at);
  CREATE INDEX usage_events_type_created_idx ON usage_events(event_type, created_at);
  CREATE INDEX usage_events_entry_created_idx ON usage_events(entry_id, created_at);
  CREATE UNIQUE INDEX usage_events_card_view_once_idx ON usage_events(session_id, entry_id) WHERE event_type = 'card_view';

  CREATE TABLE learning_state (
    client_id  TEXT NOT NULL,
    entry_id   TEXT NOT NULL,
    known      INTEGER NOT NULL CHECK (known IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (client_id, entry_id)
  );
  CREATE INDEX learning_state_updated_idx ON learning_state(updated_at);

  CREATE TABLE ai_generations (
    id          TEXT PRIMARY KEY,
    created_at  TEXT NOT NULL,
    operation   TEXT NOT NULL CHECK (operation IN ('create', 'edit')),
    provider    TEXT NOT NULL,
    model       TEXT NOT NULL,
    term        TEXT NOT NULL,
    entry_id    TEXT,
    outcome     TEXT NOT NULL CHECK (outcome IN ('success', 'invalid', 'provider_error')),
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    item_count  INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
    valid_count INTEGER NOT NULL DEFAULT 0 CHECK (valid_count >= 0),
    saved_count INTEGER NOT NULL DEFAULT 0 CHECK (saved_count >= 0),
    saved_at    TEXT
  );
  CREATE INDEX ai_generations_created_idx ON ai_generations(created_at);
  CREATE INDEX ai_generations_provider_model_idx ON ai_generations(provider, model, created_at);

  CREATE TABLE admin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX admin_audit_created_idx ON admin_audit(created_at);
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
    updateAiDefault: db.prepare('UPDATE ai_settings SET default_provider = @provider, default_model = @model WHERE id = 1'),
    appState: db.prepare('SELECT suppress_seed_when_empty, data_epoch FROM app_state WHERE id = 1'),
    insertUsage: db.prepare(`INSERT OR IGNORE INTO usage_events
      (created_at, client_id, session_id, event_type, entry_id, term, result_count, value)
      VALUES (@createdAt, @clientId, @sessionId, @type, @entryId, @term, @resultCount, @value)`),
    upsertLearning: db.prepare(`INSERT INTO learning_state (client_id, entry_id, known, updated_at)
      VALUES (@clientId, @entryId, @value, @createdAt)
      ON CONFLICT(client_id, entry_id) DO UPDATE SET known = excluded.known, updated_at = excluded.updated_at`),
    insertGeneration: db.prepare(`INSERT INTO ai_generations
      (id, created_at, operation, provider, model, term, entry_id, outcome, duration_ms, item_count, valid_count)
      VALUES (@id, @createdAt, @operation, @provider, @model, @term, @entryId, @outcome, @durationMs, @itemCount, @validCount)`),
    generationCorrelation: db.prepare('SELECT operation, saved_count, saved_at FROM ai_generations WHERE id = ?'),
    markGenerationSaved: db.prepare(`UPDATE ai_generations SET saved_count = @savedCount, saved_at = @savedAt
      WHERE id = @id AND operation = @operation AND saved_count = 0 AND saved_at IS NULL AND @savedCount > 0`),
    insertAudit: db.prepare('INSERT INTO admin_audit (created_at, action, detail) VALUES (@createdAt, @action, @detail)')
  };

  return { db, sql, transaction, close: () => db.close() };
}
