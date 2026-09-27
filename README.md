# Tarjetas de inglés

Sitio para estudiar palabras y frases en inglés con tarjetas que se voltean.

- **Frente:** significado, pronunciación americana (IPA), una aproximación para hispanohablantes, audio normal y lento, y un ejemplo.
- **Reverso:** contextos de uso, conjugaciones o variantes, más ejemplos, la trampa típica y palabras relacionadas.

Otras funciones:
- **Encontrar tarjetas:** filtros por nivel y tipo, seis criterios de orden, búsqueda sin tildes y scroll infinito.
- **Estudiar:** modo práctica y marcado de "ya la sé".
- **Agregar tarjetas:** pegar el JSON que genera una IA, subir archivos o crearlas con IA directamente desde la búsqueda.
- **Administrar tarjetas:** buscar, paginar, regenerar con instrucciones y proveedor/modelo explícitos, previsualizar, renombrar o eliminar.

## Tecnologías

| Capa | Tecnología |
|---|---|
| Entorno | Node.js 22.13+ (recomendado 24 LTS), módulos ES |
| Backend | Express 5, express-rate-limit |
| Base de datos | SQLite integrado en Node (`node:sqlite`), modo WAL |
| Frontend | HTML, CSS y JavaScript sin framework, empaquetado con Vite 8 (varias páginas) |
| APIs del navegador | Web Speech API (voz), IntersectionObserver, localStorage, `<dialog>` |
| IA | Cualquier API compatible con OpenAI (OpenCode Go, Gemini, OpenAI, Azure OpenAI, Ollama…) y Anthropic, con `fetch` |
| Pruebas | `node:test` |
| Despliegue | Docker (multi-etapa) o Node con pm2/systemd detrás de un proxy |

## Puesta en marcha

```bash
npm install
cp .env.example .env      # completa ADMIN_TOKEN y la clave de tu proveedor de IA
npm run dev               # http://localhost:3000
```

En Windows (PowerShell), usa `Copy-Item .env.example .env` en lugar de `cp`.

La primera vez se crea `data/vocab.db` y se cargan los ejemplos de `data/seed/`.

| Comando | Qué hace |
|---|---|
| `npm run dev` | Servidor + Vite con recarga en caliente; reinicia el backend al cambiar `server/`. |
| `npm test` | Pruebas del backend. |
| `npm run build` | Compila el frontend en `dist/`. |
| `npm start` | Producción: sirve `dist/` y la API. |
| `npm run preview` | `build` + `start`. |

## Estructura

```
server/     Backend (API, base de datos, importación, IA, autenticación) y pruebas
web/        Frontend: index.html (tarjetas), import.html (agregar), src/
prompts/    Prompt con el que la IA genera tarjetas
schema/     JSON Schema del formato de datos
docs/       Modelo de datos, base de datos y API
data/seed/  Datos de ejemplo
```

Detalles del contrato de datos y la API: [`docs/data-model.md`](docs/data-model.md).
Cómo funciona y cómo editar el prompt: [`prompts/README.md`](prompts/README.md).
Guía para agentes de código: [`AGENTS.md`](AGENTS.md).

## Configuración

`config.json` guarda la configuración que no es secreta y se versiona. Los
secretos van en `.env`, que Git ignora.

| Clave | Por defecto | Descripción |
|---|---|---|
| `dbPath` | `data/vocab.db` | Archivo de la base de datos. |
| `dataFolder` | `data/seed` | Carpeta que se puede importar desde el sitio. |
| `seedFromFolderWhenEmpty` | `true` | Importar `dataFolder` si la base está vacía al arrancar. |
| `pageSize` / `maxPageSize` | `12` / `100` | Tamaño de página del scroll infinito. |
| `maxImportBytes` | 5 MB | Tamaño máximo por archivo o texto importado. |
| `trustProxy` | `false` | Pon `1` detrás de Nginx o IIS. |
| `host` / `port` | `0.0.0.0` / `3000` | Dónde escucha el servidor. |
| `ai.provider` | `opencode-go` | Proveedor heredado; la selección operativa se administra globalmente desde la interfaz. |
| `ai.model` | según proveedor | Modelo heredado; no reemplaza el predeterminado global persistido. |
| `ai.providers` | `{}` | Opciones por proveedor y configuración explícita de custom u Ollama. |
| `ai.baseUrl` | según proveedor | Obligatorio para `custom`. |
| `ai.promptFile` | `prompts/vocab-entry.prompt.md` | Prompt de sistema. |
| `ai.timeoutMs` | `90000` | Tiempo máximo de espera de la IA. |
| `ai.catalogTtlMs` / `ai.catalogTimeoutMs` | `300000` / `10000` | Vigencia de la caché y timeout de descubrimiento. |
| `ai.jsonMode` | según proveedor | `false` si el proveedor rechaza `response_format`. |

Variables de entorno (`.env`):
- **Administración:** `ADMIN_TOKEN`.
- **Claves de IA:** `OPENCODE_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` y `AZURE_OPENAI_API_KEY`.
- **Azure OpenAI:** `AZURE_OPENAI_ENDPOINT`, junto con `AZURE_OPENAI_API_KEY`. Tras cambiar una clave o endpoint, reinicia el servidor.
- **Compatibilidad:** `AI_API_KEY` solo autentica un proveedor que esté configurado explícitamente y sea el único sin clave específica; nunca habilita varios proveedores a la vez.
- **Opcionales:** `PORT`, `HOST`, `VOCAB_DB`, `VOCAB_DATA_FOLDER`, `VOCAB_PAGE_SIZE` y `VOCAB_CONFIG`.

Las suscripciones web (ChatGPT Plus, la app de Gemini, Copilot) no incluyen
acceso por API: se necesita una clave de API del proveedor.

Las claves específicas habilitan automáticamente OpenCode Go, OpenAI, Anthropic
y Gemini: no los agregues manualmente a `ai.providers`. Si una clave no existe,
ese proveedor no aparece aunque quede una entrada antigua en `config.json`.
`ai.providers` NO contiene listas de modelos: sirve para sobrescribir opciones
no secretas y para configurar explícitamente los proveedores que no pueden
activarse solo con una clave. El servidor obtiene los IDs publicados desde el
catálogo de cada proveedor, sin asumir que la credencial pueda invocarlos.

```json
{
  "ai": {
    "providers": {
      "ollama": {},
      "custom": { "baseUrl": "https://proveedor.example/v1", "auth": "none" }
    }
  }
}
```

Azure se habilita automáticamente solo cuando `AZURE_OPENAI_API_KEY` y
`AZURE_OPENAI_ENDPOINT` tienen valor; no requiere una entrada en `config.json`.
El endpoint puede ser la raíz copiada del portal, por ejemplo
`https://recurso.openai.azure.com` o `https://recurso.services.ai.azure.com`, o
la URL completa terminada en `/openai/v1`. El servidor quita barras finales y
agrega `/openai/v1` únicamente cuando falta. Custom requiere `baseUrl` y usa
`AI_API_KEY`, salvo que se configure deliberadamente con
`"auth": "none"`. Ollama no usa clave, pero requiere su entrada explícita y no
se sondea localhost automáticamente.

OpenCode Go usa `https://opencode.ai/zen/go/v1/models`; no se mezcla con el
producto OpenCode Zen. OpenAI usa `/v1/models`, Anthropic pagina `/v1/models`,
Gemini usa su listado nativo y Ollama usa `/api/tags`. `custom` consulta
`{baseUrl}/models` y Azure consulta `{AZURE_OPENAI_ENDPOINT}/openai/v1/models`;
si el servicio no ofrece discovery, el proveedor publica un error en vez de
inventar modelos. Las opciones de transporte en `ai.providers` se aplican a los
proveedores configurables, no reemplazan la clave ni el endpoint de Azure. Usa
`"auth": "none"` solo para un servicio compatible que realmente no requiera clave.

El catálogo se guarda cinco minutos en memoria y deduplica actualizaciones
concurrentes. Si una actualización falla después de un éxito, se conserva el
último snapshot marcado como desactualizado; sin un snapshot previo se omite
solo ese proveedor. Las rutas públicas exponen únicamente los modelos que el
administrador marcó como visibles, con IDs, etiquetas, categoría, frescura y
errores sanitizados, nunca claves, endpoints ni URLs internas. **Actualizar modelos** en
Administración fuerza una consulta nueva con la autenticación administrativa.

En **Administración → Configuración de IA** hay dos secciones. **Modelo
predeterminado** contiene solo modelos visibles y permite elegir el único valor
global. **Catálogo completo** contiene todos los modelos descubiertos y permite
controlar su visibilidad y categoría: **Sin clasificar**, **Eficiente** (menor
costo y tareas simples), **Equilibrado** o **Avanzado** (mayor capacidad y
costo). Estos ajustes se guardan en SQLite y se comparten con todos los
navegadores; visibilidad significa curación administrativa, no garantiza que la
cuenta del proveedor pueda invocar el modelo.

Los modelos nuevos son visibles y quedan **Sin clasificar** hasta que se guarde
otra decisión. Si un modelo desaparece del catálogo, sus preferencias se
conservan para cuando regrese. Si desaparece o se oculta el predeterminado, el
servidor usa de forma determinista el primer modelo visible sin sobrescribir el
valor guardado. Es válido ocultarlos todos: no habrá predeterminado y la creación
con IA quedará deshabilitada. Al abrir **Crear con IA** o una edición, el selector
parte del predeterminado global; cualquier alternativa elegida se conserva
durante todos los reintentos del flujo actual. Las instrucciones adicionales
permiten pedir otro contexto, ampliar una explicación o exigir un ejemplo. El
texto entre `<<` y `>>` se trata como una unidad semántica completa y esos
delimitadores no se copian a la tarjeta. La antigua clave local
`vocab-ai-default-model` se elimina y ya no es una fuente de configuración.

La página principal incluye **Desbloquear administración**. Solo después de
validar la clave con `/api/admin/check` aparecen las acciones de edición y
creación; un `401` borra la clave local y vuelve a bloquearlas. La seguridad no
depende de esa interfaz: editar, guardar y eliminar siguen requiriendo
`Authorization: Bearer <ADMIN_TOKEN>` en el servidor. En **Administración →
Tarjetas** se puede buscar y paginar el catálogo, seleccionar una tarjeta,
regenerarla con IA, revisar la vista previa y guardarla o eliminarla con
confirmación. Si la edición cambia el id, el guardado reemplaza la fila original
atómicamente y migra el id en la lista local de tarjetas aprendidas.

### Sesiones de OpenCode Go

OpenCode Go recibe `User-Agent: vocab-cards/1.0.0` y un identificador opaco
`x-opencode-session`. El servidor genera ese UUID: no contiene palabras ni
datos de las tarjetas. En **Agregar tarjetas**, después de iniciar la sesión de
administración, se puede configurar cuántas solicitudes comparten el mismo
identificador (50 por defecto; entero entre 1 y 1000). El valor se guarda solo
en `localStorage` de ese navegador y se valida otra vez en el servidor.

Las solicitudes 1 a N usan el mismo UUID; antes de enviar la N+1 se genera uno
nuevo. El contador y el UUID viven en memoria del proceso, son compartidos por
la única instancia del servidor y se reinician al reiniciar Node. Si distintos
navegadores envían límites diferentes, cada solicitud aplica su límite al
contador compartido actual: reducirlo puede rotar en la siguiente solicitud y
aumentarlo puede prolongar la sesión actual hasta el nuevo límite. Ninguna de
estas cabeceras ni esta lógica se aplica a otros proveedores. Cada intento de
envío cuenta, incluso si OpenCode Go devuelve un error o no responde.

## Despliegue

**Docker**

```bash
docker build -t vocab-cards .
docker run -d -p 3000:3000 --env-file .env -v vocab-data:/data --restart unless-stopped vocab-cards
```

**Node en un servidor**

```bash
npm ci
npm run build
npm prune --omit=dev
pm2 start "npm start" --name vocab
```

Pon Nginx o IIS (ARR) delante para HTTPS y ajusta `trustProxy`. Define
`ADMIN_TOKEN` antes de publicar: la clave viaja en cada petición de escritura.
El frontend usa rutas relativas, así que también funciona en un subdirectorio.

**Respaldos:** usa **Agregar tarjetas → Descargar respaldo JSON** (se puede
volver a importar) o `sqlite3 data/vocab.db ".backup copia.db"`.
