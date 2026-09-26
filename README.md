# Tarjetas de inglés

Sitio para estudiar palabras y frases en inglés con tarjetas que se voltean.

- **Frente:** significado, pronunciación americana (IPA), una aproximación para hispanohablantes, audio normal y lento, y un ejemplo.
- **Reverso:** contextos de uso, conjugaciones o variantes, más ejemplos, la trampa típica y palabras relacionadas.

Otras funciones:
- **Encontrar tarjetas:** filtros por nivel y tipo, seis criterios de orden, búsqueda sin tildes y scroll infinito.
- **Estudiar:** modo práctica y marcado de "ya la sé".
- **Agregar tarjetas:** pegar el JSON que genera una IA, subir archivos o crearlas con IA directamente desde la búsqueda.

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
| `ai.provider` | `opencode-go` | `opencode-go`, `gemini`, `openai`, `anthropic`, `azure`, `ollama` o `custom`. |
| `ai.model` | según proveedor | Modelo de fallback y predeterminado inicial. |
| `ai.providers` | `{"opencode-go": {}}` | Proveedores cuyos modelos se descubren desde sus APIs oficiales. |
| `ai.baseUrl` | según proveedor | Obligatorio para `azure` y `custom`. |
| `ai.promptFile` | `prompts/vocab-entry.prompt.md` | Prompt de sistema. |
| `ai.timeoutMs` | `90000` | Tiempo máximo de espera de la IA. |
| `ai.catalogTtlMs` / `ai.catalogTimeoutMs` | `300000` / `10000` | Vigencia de la caché y timeout de descubrimiento. |
| `ai.jsonMode` | según proveedor | `false` si el proveedor rechaza `response_format`. |

Variables de entorno (`.env`):
- **Administración:** `ADMIN_TOKEN`.
- **Claves de IA:** `OPENCODE_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_API_KEY`, y `AI_API_KEY`, que sirve para cualquier proveedor y tiene prioridad.
- **Opcionales:** `PORT`, `HOST`, `VOCAB_DB`, `VOCAB_DATA_FOLDER`, `VOCAB_PAGE_SIZE` y `VOCAB_CONFIG`.

Las suscripciones web (ChatGPT Plus, la app de Gemini, Copilot) no incluyen
acceso por API: se necesita una clave de API del proveedor.

`ai.providers` controla qué proveedores se consultan. NO contiene listas de
modelos: el servidor obtiene los IDs autorizados desde el catálogo oficial de
cada proveedor. Por defecto solo se configura `opencode-go`; Ollama no se
consulta ni aparece salvo que exista una entrada explícita. Para habilitar
otros proveedores, agrega entradas vacías o sus opciones no secretas:

```json
{
  "ai": {
    "providers": {
      "opencode-go": {},
      "openai": {},
      "anthropic": {},
      "gemini": {},
      "ollama": {},
      "custom": { "baseUrl": "https://proveedor.example/v1" }
    }
  }
}
```

OpenCode Go usa `https://opencode.ai/zen/go/v1/models`; no se mezcla con el
producto OpenCode Zen. OpenAI usa `/v1/models`, Anthropic pagina `/v1/models`,
Gemini usa su listado nativo y Ollama usa `/api/tags`. `custom` y `azure`
consultan `{baseUrl}/models`; si el servicio no ofrece discovery, el proveedor
publica un error en vez de inventar modelos. Cada proveedor admite `baseUrl`,
`catalogUrl`, `auth`, `jsonMode`, `temperature`, `timeoutMs` y `maxTerms`. Usa
`"auth": "none"` solo para un servicio compatible que realmente no requiera clave.

El catálogo se guarda cinco minutos en memoria y deduplica actualizaciones
concurrentes. Si una actualización falla después de un éxito, se conserva el
último snapshot marcado como desactualizado; sin un snapshot previo se omite
solo ese proveedor. Las rutas públicas exponen IDs, etiquetas, frescura y
errores sanitizados, nunca claves ni URLs internas. **Actualizar modelos** en
Administración fuerza una consulta nueva con la autenticación administrativa.

En **Agregar tarjetas → Modelo predeterminado**, Administración permite elegir
el modelo inicial del navegador. La estrella resalta el actual y el valor se
guarda en `localStorage` con la clave `vocab-ai-default-model`. Al abrir **Crear
con IA**, el selector parte de ese predeterminado, pero cualquier alternativa
elegida allí solo dura mientras el cuadro permanece abierto. Si el valor
guardado quedó obsoleto o corrupto, se usa `ai.provider` + `ai.model` si ese par
aparece en el snapshot oficial; en otro caso se usa el primer modelo descubierto.

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
