# Modelo de datos

Este documento describe el contrato de datos del proyecto: la tarjeta, los
archivos que se importan, la base de datos y la API. El esquema formal está en
[`schema/vocab-entries.schema.json`](../schema/vocab-entries.schema.json).

## Tarjeta (entrada de vocabulario)

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `id` | string | no | Identificador único. Si falta, se genera desde `head` (ver regla abajo). |
| `kind` | enum | no (por defecto `word`) | Tipo principal: define el color y el filtro. |
| `head` | string | **sí** | Palabra o frase tal como se muestra. |
| `say` | string | no (por defecto `head`) | Texto que lee la síntesis de voz. |
| `tags` | string[] | no | 1 a 3 etiquetas: categoría gramatical en inglés, rasgos en español. |
| `level` | enum | no | Nivel MCER: `A1`, `A2`, `B1`, `B2`, `C1`, `C2`. |
| `ipa` | string | no | Pronunciación americana en IPA, entre barras: `/ɡɪv ˈʌp/`. |
| `lat` | string | no | Pronunciación para hispanohablantes: sílabas con guion, la tónica en MAYÚSCULAS: `guiv-ÁP`. |
| `meaning` | string | **sí** (aviso si falta) | Significado en español, máximo unas 12 palabras. |
| `ex` | `{ en, es }` | no | Ejemplo principal (frente de la tarjeta). |
| `contexts` | `{ title, text }[]` | no | 1 a 3 usos o acepciones. |
| `formsLabel` | string | no | Encabezado de `forms`: `Conjugación`, `Variantes`, `Familia` o `Formas`. |
| `forms` | string[] | no | Conjugaciones, variantes o palabras de la familia. |
| `examples` | `{ en, es }[]` | no | Ejemplos adicionales (reverso). Se esperan 2. |
| `note` | string | no | Trampa típica para hispanohablantes o consejo de uso. |
| `related` | string[] | no | Palabras relacionadas; los antónimos se marcan con `(≠)`. |
| `addedAt` | ISO 8601 | no | Fecha de adición. Si falta, el servidor usa la fecha actual (o la del archivo al importar una carpeta). |

Campos que agrega el servidor en las respuestas de la API (no se importan):
`updatedAt` (última modificación) y `source` (archivo o importación de origen).

### Valores de `kind`

| Valor | Uso | Ejemplo |
|---|---|---|
| `phrasal` | Phrasal verbs y verbos preposicionales | give up, look forward to |
| `idiom` | Expresiones de sentido figurado | break the ice |
| `phrase` | Frases funcionales: saludos, peticiones, respuestas | How's it going? |
| `onomatopoeia` | Sonidos | whoosh, thud |
| `word` | Una sola palabra de cualquier categoría | themselves, actually |
| `grammar` | Estructuras gramaticales | used to, I wish |

Un `kind` desconocido se acepta con un aviso y se muestra en gris.

### Regla del `id`

`slug(head)` en `server/entry.js`:

1. Pasar a minúsculas.
2. Quitar las tildes.
3. Eliminar los apóstrofos.
4. Reemplazar cada secuencia de caracteres que no sean letras o números por `-`.
5. Recortar los guiones de los extremos.

| `head` | `id` |
|---|---|
| `give up` | `give-up` |
| `How’s it going?` | `hows-it-going` |
| `Would you mind…?` | `would-you-mind` |

Si se envía un `id`, también se normaliza con esta regla. El `id` decide si una
importación crea una tarjeta nueva o actualiza una existente.

### Ejemplo completo

```json
{
  "id": "give-up",
  "kind": "phrasal",
  "head": "give up",
  "say": "give up",
  "tags": ["separable"],
  "level": "B1",
  "ipa": "/ɡɪv ˈʌp/",
  "lat": "guiv-ÁP",
  "meaning": "Rendirse; dejar de hacer algo.",
  "ex": { "en": "Don't give up now, you're almost there.", "es": "No te rindas ahora, ya casi llegas." },
  "contexts": [
    { "title": "Rendirse", "text": "dejar de intentar algo difícil." },
    { "title": "Dejar un hábito", "text": "give up smoking, give up sugar." }
  ],
  "formsLabel": "Conjugación",
  "forms": ["gives up", "gave up", "given up", "giving up"],
  "examples": [
    { "en": "I gave up sugar for a month.", "es": "Dejé el azúcar por un mes." },
    { "en": "She gave her seat up for an older man.", "es": "Le cedió su asiento a un señor mayor." }
  ],
  "note": "Separable: con pronombre va en medio. Se dice give it up, nunca give up it.",
  "related": ["quit", "stop", "surrender"]
}
```

## Formatos que acepta la importación

Cualquiera de estos, pegado como texto, subido como archivo o leído de la carpeta `dataFolder`:

- **Objeto con entradas:** `{ "entries": [ ... ] }`. Es el formato recomendado y el que produce la exportación; puede incluir `$schema` y `exportedAt`.
- **Arreglo de entradas:** `[ ... ]`.
- **Una sola entrada:** `{ "head": ... }`.

El importador tolera comentarios (`//`, `/* */`), comas finales y respuestas
de IA con bloques ` ```json ` o texto alrededor. Los pares en formato antiguo
`["en", "es"]` se convierten a `{ en, es }`.

### Estados de la revisión

| Estado | Significado |
|---|---|
| `new` | No existe: se insertará. |
| `update` | Existe y cambió: se reemplazará completa (se conserva `addedAt` salvo que venga uno nuevo). |
| `same` | Existe y es idéntica: no se toca. |
| `skip` | Existe y el modo es `keep`: se conserva la guardada. |
| `duplicate` | Se repite en el mismo lote: gana la última aparición. |
| `error` | No se pudo leer o le falta `head`. |

## Base de datos (SQLite, `node:sqlite`)

Archivo: `dbPath` (por defecto `data/vocab.db`), en modo WAL. Las migraciones
están en `server/db.js` y usan `PRAGMA user_version`.

```sql
CREATE TABLE entries (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,  -- orden de inserción (desempate)
  id          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  data        TEXT    NOT NULL,                   -- tarjeta normalizada en JSON (sin addedAt ni source)
  added_at    TEXT    NOT NULL,                   -- ISO 8601
  updated_at  TEXT    NOT NULL,
  source      TEXT
);

CREATE TABLE imports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  origin      TEXT    NOT NULL,                   -- texto | archivo | carpeta | ia
  sources     TEXT    NOT NULL,
  mode        TEXT    NOT NULL,                   -- update | keep
  inserted    INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  unchanged   INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  errors      INTEGER NOT NULL DEFAULT 0
);
```

El servidor mantiene todas las tarjetas en memoria para filtrar y ordenar; cada
escritura se hace en una transacción y luego refresca esa copia.

## API

Lectura (pública):

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| GET | `/api/vocab/meta` | `{ total, lastUpdated, pageSize, levels: {A2: n…}, kinds: {phrasal: n…}, ai: { enabled, provider, label, model } \| { enabled: false, reason } }` |
| POST | `/api/vocab/query` | Cuerpo: `{ skip, take, sort, dir, seed, q, levels, kinds, excludeIds }` → `{ total, skip, items: Tarjeta[], hasMore, exact: { id, head } \| null }` |
| GET | `/api/vocab/export` | `{ $schema, exportedAt, entries: Tarjeta[] }` (descarga) |

- `sort`: `added`, `alpha`, `level`, `kind`, `length` o `random` (estable según `seed`). `dir`: `asc` o `desc`.
- `levels` y `kinds`: `null` es todos; `[]` es ninguno.
- `exact`: la tarjeta cuyo texto coincide exactamente con `q`, sin importar filtros, mayúsculas, tildes ni signos.

Escritura (cabecera `Authorization: Bearer <ADMIN_TOKEN>`, máximo 30 por minuto):

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| DELETE | `/api/vocab/entries/:id` | `{ ok, total }` |
| GET | `/api/admin/check` | `{ ok, total, dataFolder, maxImportBytes, ai, opencodeSessionLimit: { default, min, max } }` |
| POST | `/api/admin/import` | `{ sources: [{ name, text }], mode: "update" \| "keep", dryRun, origin }` → `{ items, summary, importId? }` |
| POST | `/api/admin/import-folder` | `{ mode, dryRun }` → igual que `import` |
| GET | `/api/admin/imports` | Últimas 15 filas de `imports` |
| POST | `/api/admin/ai/generate` | `{ term, hint, mode, opencodeSessionRequestLimit? }` → `{ provider, label, model, source, text, items (con entry), summary }`. No guarda; máximo 10 por minuto. Para `opencode-go`, el límite debe ser un entero entre 1 y 1000; si se omite, usa 50. |

`summary`: `{ new, update, same, skip, duplicate, error }`. Cada elemento de
`items`: `{ status, source, index, id, head, kind, level, message }`.
