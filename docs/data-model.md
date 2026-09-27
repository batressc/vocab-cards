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

CREATE TABLE ai_model_preferences (
  provider TEXT NOT NULL,
  model    TEXT NOT NULL,
  visible  INTEGER NOT NULL CHECK (visible IN (0, 1)),
  category TEXT NOT NULL CHECK (category IN ('unclassified', 'efficient', 'balanced', 'advanced')),
  PRIMARY KEY (provider, model)
);

CREATE TABLE ai_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  default_provider TEXT,
  default_model    TEXT,
  CHECK ((default_provider IS NULL) = (default_model IS NULL))
);
```

La migración `v3` agrega cinco áreas persistentes:

| Tabla | Propósito |
|---|---|
| `app_state` | Fila única con `suppress_seed_when_empty` y `data_epoch`. |
| `usage_events` | Eventos semánticos anónimos de búsqueda, vista, giro, audio y cambios de aprendizaje/práctica. |
| `learning_state` | Último estado “ya la sé” por cliente anónimo y tarjeta. |
| `ai_generations` | Operación, proveedor/modelo, término normalizado, resultado, duración, conteos y conversión a guardado. |
| `admin_audit` | Acciones administrativas estructuradas sin prompts, respuestas ni secretos. |

Las tablas de métricas no tienen claves foráneas hacia `entries`: el historial
sobrevive a eliminar una tarjeta individual o a limpiar todas las tarjetas. Los
índices cubren fecha, tipo de evento, tarjeta y proveedor/modelo. Una vista de
tarjeta se deduplica por sesión y tarjeta mediante un índice único parcial.

`data_epoch` aumenta cuando limpiar tarjetas o reiniciar todo elimina tarjetas o
activa por primera vez la inhibición del seed. El cliente lo compara
con su valor local para descartar ids aprendidos que puedan haber quedado
obsoletos. Esas operaciones también fijan `suppress_seed_when_empty = 1`; por
ello `seedFromFolderWhenEmpty` no vuelve a cargar `data/seed` en el siguiente
arranque. Importar contenido posteriormente no reactiva el seed automático.

El servidor mantiene todas las tarjetas en memoria para filtrar y ordenar; cada
escritura se hace en una transacción y luego refresca esa copia.
La curación de modelos también se escribe en una transacción. Sus filas no se
eliminan cuando un modelo desaparece del snapshot, para poder reaplicarlas si
vuelve a publicarse.

La edición dirigida recibe el id original por separado. En una sola transacción
actualiza la fila objetivo y puede cambiar `id` junto con `head`; conserva
`added_at`, actualiza `updated_at` y rechaza el nuevo id si pertenece a otra
fila. No utiliza la importación genérica, por lo que una renombración nunca crea
accidentalmente la tarjeta nueva dejando también la original.

## API

Lectura (pública):

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| GET | `/api/vocab/meta` | `{ total, lastUpdated, pageSize, levels, kinds, dataEpoch, ai: { enabled, provider?, label?, model?, default, providers: [{ id, label, stale, fetchedAt, models: [{ id, label, group?, category }] }], fetchedAt, refreshedAt, expiresAt, stale, errors: [{ provider, message }] } }`. `providers` contiene solo modelos visibles. |
| POST | `/api/vocab/query` | Cuerpo: `{ skip, take, sort, dir, seed, q, levels, kinds, excludeIds }` → `{ total, skip, items: Tarjeta[], hasMore, exact: { id, head } \| null }` |
| GET | `/api/vocab/export` | `{ $schema, exportedAt, entries: Tarjeta[] }` (descarga) |
| POST | `/api/telemetry/events` | Lote anónimo acotado: `{ clientId, sessionId, events }` → `202 { ok, accepted }`. Tiene limitador independiente por IP. |

- `sort`: `added`, `alpha`, `level`, `kind`, `length` o `random` (estable según `seed`). `dir`: `asc` o `desc`.
- `levels` y `kinds`: `null` es todos; `[]` es ninguno.
- `exact`: la tarjeta cuyo texto coincide exactamente con `q`, sin importar filtros, mayúsculas, tildes ni signos.

Escritura (cabecera `Authorization: Bearer <ADMIN_TOKEN>`, máximo 30 por minuto):

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| DELETE | `/api/vocab/entries/:id` | `{ ok, total }` |
| GET | `/api/admin/check` | `{ ok, total, dataFolder, maxImportBytes, ai, opencodeSessionLimit: { default, min, max } }`. `ai.providers` es la proyección visible y `ai.allProviders` es el snapshot completo con `visible` y `category` efectivos. |
| POST | `/api/admin/ai/models/refresh` | Fuerza el descubrimiento y devuelve la misma vista administrativa completa, con frescura y errores sanitizados. |
| PUT | `/api/admin/ai/curation` | `{ models: [{ provider, model, visible, category }], default: { provider, model } \| null }` → vista administrativa actualizada. Debe incluir exactamente una vez cada modelo del snapshot completo vigente. |
| POST | `/api/admin/import` | `{ sources: [{ name, text }], mode: "update" \| "keep", dryRun, origin, generationId? }` → `{ items, summary, importId? }` |
| POST | `/api/admin/import-folder` | `{ mode, dryRun }` → igual que `import` |
| GET | `/api/admin/imports` | Últimas 15 filas de `imports` |
| GET | `/api/admin/entries/:id` | Devuelve la tarjeta vigente cargada por el servidor. |
| PUT | `/api/admin/entries/:id` | `{ entry, source?, generationId? }` → `{ ok, entry, previousId, warnings }`. Reemplazo dirigido que permite renombrar y devuelve `404` si falta el objetivo o `409` ante colisión. |
| DELETE | `/api/admin/entries/:id` | `{ ok, total }` |
| POST | `/api/admin/ai/generate` | `{ term, hint, instructions?, provider, model, opencodeSessionRequestLimit? }` → `{ generationId, provider, label, model, source, text, items (con entry), summary }`. No guarda; máximo 10 por minuto. |
| POST | `/api/admin/ai/edit` | `{ entryId, instructions?, provider, model, opencodeSessionRequestLimit? }` → la misma vista previa, con exactamente una entrada válida. La tarjeta actual se obtiene por `entryId` en el servidor. |
| GET | `/api/admin/statistics?range=7d\|30d\|90d\|all` | KPIs, serie diaria y agregaciones por proveedor/modelo, tarjeta, búsqueda y término generado. |
| GET | `/api/admin/maintenance/summary` | Conteos previos de tarjetas, auditoría, métricas, preferencias, epoch y estado de seed. |
| POST | `/api/admin/maintenance/clear` | `{ scope, confirmation }`; `scope`: `cards`, `audit`, `metrics` o `all`. |

### Telemetría y privacidad

El navegador crea un UUID persistente de cliente y otro por sesión. El endpoint
acepta lotes de hasta 50 eventos y rechaza campos desconocidos. Tipos válidos:
`search`, `card_view`, `card_flip`, `audio_play`, `known_changed` y
`practice_changed`. Solo se conservan el término normalizado de búsqueda, el id
de tarjeta, conteos y estados booleanos necesarios. No se guardan IP,
user-agent, tokens, hints, instrucciones/prompts ni respuestas de IA.

Las generaciones se registran en el backend, incluso si el proveedor falla o el
contenido no valida. Cada `generationId` es el UUID v4 canónico emitido por el
backend y se consume una sola vez. Una generación con operación `create` solo
puede correlacionarse al aplicar una importación (`import/apply`); una con
operación `edit`, solo al reemplazar mediante `PUT /api/admin/entries/:id`
(`replace`). La correlación y el consumo ocurren dentro de la misma transacción
que completa `saved_count` y `saved_at`.

Un guardado sin cambios se rechaza y no consume el `generationId`. Los errores
públicos de correlación son:

- `GENERATION_NOT_FOUND`: el `generationId` no existe.
- `GENERATION_ALREADY_CONSUMED`: la generación ya se correlacionó con otro guardado.
- `GENERATION_OPERATION_MISMATCH`: la operación de la generación no corresponde
  al tipo de guardado.
- `GENERATION_WITHOUT_CHANGES`: el guardado no produciría cambios.

### Mantenimiento

Las frases exactas son `ELIMINAR TARJETAS`, `LIMPIAR AUDITORÍA`,
`LIMPIAR MÉTRICAS` y `REINICIAR TODO`. Todas las limpiezas son transaccionales;
si el alcance ya está limpio y no queda estado que restablecer, repetirlas no
crea auditoría ni incrementa `data_epoch`. Tienen un limitador más estricto y
nunca ejecutan `VACUUM`.

- `cards`: borra `entries`, inhibe el seed e incrementa el epoch solo cuando
  había tarjetas o la inhibición todavía no estaba activa.
- `audit`: borra `imports` y `admin_audit`, y deja una única marca `audit.cleared`.
- `metrics`: borra `usage_events`, `learning_state` y `ai_generations`.
- `all`: combina lo anterior, reinicia `ai_model_preferences`/`ai_settings` y deja una única marca `system.reset`.

Ningún alcance borra el archivo SQLite, `config.json`, `.env` o `data/seed`.
Limpiar métricas tampoco puede borrar `localStorage` en navegadores desconectados.

`summary`: `{ new, update, same, skip, duplicate, error }`. Cada elemento de
`items`: `{ status, source, index, id, head, kind, level, message }`.

`instructions` admite hasta 2000 caracteres. `provider` y `model` son
obligatorios en cada generación y deben formar un par visible del catálogo
vigente; un modelo oculto se rechaza aunque se envíe manualmente. Para
`opencode-go`, el límite debe ser un entero entre 1 y 1000; si se omite, usa 50.
La notación `<<...>>` conserva todo el contenido delimitado como una unidad
semántica en el mensaje enviado a la IA; los delimitadores no deben aparecer en
la tarjeta salvo petición expresa.

Las claves específicas habilitan automáticamente OpenCode Go, OpenAI, Anthropic
y Gemini; una entrada obsoleta en `ai.providers` no los habilita sin credencial.
Azure se habilita solo con `AZURE_OPENAI_API_KEY` y `AZURE_OPENAI_ENDPOINT`; la
raíz del portal se normaliza a `/openai/v1` y no requiere cambios en
`config.json`. Custom y Ollama requieren configuración explícita no secreta.
`AI_API_KEY` solo se aplica cuando existe un único proveedor explícito sin clave
específica. Los IDs proceden de la API oficial de cada uno. OpenCode Go usa su
catálogo `/zen/go/v1/models`,
separado de Zen, y models.dev solo aporta etiquetas, familias, protocolo y
capacidades: nunca concede pertenencia. El servidor cachea el catálogo,
deduplica refresh concurrente y aplica stale-if-error por proveedor. Nunca
publica claves, endpoints, `baseUrl` ni detalles de errores remotos. Una
selección ausente devuelve `400` antes de generar.

La generación desacopla credenciales y transporte: puede usar
`/chat/completions`, Anthropic `/messages` u OpenAI `/responses`. Todo modelo de
OpenCode Go conserva `User-Agent` y `x-opencode-session`; los parámetros que la
metadata marca como incompatibles, como `temperature`, se omiten.

La visibilidad, categoría y selección predeterminada son ajustes globales de
SQLite. Las categorías válidas son `unclassified` (**Sin clasificar**),
`efficient` (**Eficiente**), `balanced` (**Equilibrado**) y `advanced`
(**Avanzado**). Un modelo sin fila persistida es visible y queda sin clasificar.
La visibilidad representa una decisión administrativa; no afirma que las
credenciales tengan entitlement, cuota o acceso efectivo en el proveedor.

Guardar exige que el predeterminado pertenezca al snapshot actual y sea visible
si existe al menos un modelo visible. Con cero visibles exige `default: null` y
la IA pública queda deshabilitada. Si el predeterminado persistido desaparece o
se oculta, la lectura usa el primer modelo visible en orden de snapshot sin
modificar la fila persistida. La vista administrativa conserva el catálogo
completo y señala ese fallback; la vista pública, el selector principal y el
diálogo solo reciben la proyección visible. Cada flujo inicia con `ai.default`,
pero envía siempre la selección explícita y mantiene cualquier cambio durante
todos sus reintentos. El valor antiguo de
`localStorage` se elimina y nunca participa en la resolución.
