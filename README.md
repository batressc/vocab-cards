# Tarjetas de inglés

Sitio para estudiar palabras y frases en inglés con tarjetas que se voltean.

- **Frente:** significado, pronunciación americana (IPA), una aproximación para hispanohablantes, audio normal y lento, y un ejemplo.
- **Reverso:** contextos de uso, conjugaciones o variantes, más ejemplos, la trampa típica y palabras relacionadas.

Otras funciones:
- **Encontrar tarjetas:** filtros por nivel y tipo, seis criterios de orden, búsqueda sin tildes y scroll infinito.
- **Estudiar:** modo práctica y marcado de "ya la sé".
- **Agregar tarjetas:** pegar el JSON que genera una IA, subir archivos o crearlas con IA directamente desde la búsqueda.
- **Administrar tarjetas:** buscar, paginar, regenerar con instrucciones y proveedor/modelo explícitos, previsualizar, renombrar o eliminar.
- **Medir y mantener:** estadísticas anónimas de estudio y generaciones IA, más limpiezas administrativas separadas para tarjetas, auditoría, métricas o todo el estado gestionado.
- **Respaldar y restaurar:** copias SQLite completas, consistentes y protegidas por la clave administrativa; la restauración recupera todo el estado de la aplicación.

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
Si un administrador elimina todas las tarjetas desde la Zona de peligro, esa
decisión queda persistida y los ejemplos no reaparecen al reiniciar.

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

`config.json` guarda la configuración que no es secreta y se versiona. En
desarrollo los secretos pueden ir en `.env`, que Git ignora; en contenedor se
recomienda `AI_CREDENTIALS_FILE` sobre un directorio montado de solo lectura.

| Clave | Por defecto | Descripción |
|---|---|---|
| `dbPath` | `data/vocab.db` | Archivo de la base de datos. |
| `dataFolder` | `data/seed` | Carpeta que se puede importar desde el sitio. |
| `seedFromFolderWhenEmpty` | `true` | Importar `dataFolder` si la base está vacía al arrancar. |
| `pageSize` / `maxPageSize` | `12` / `100` | Tamaño de página del scroll infinito. |
| `maxImportBytes` | 5 MB | Tamaño máximo por archivo o texto importado. |
| `maxBackupBytes` | 64 MB | Tamaño máximo de un archivo SQLite subido para restaurar. |
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
- **Azure OpenAI:** `AZURE_OPENAI_ENDPOINT`, junto con `AZURE_OPENAI_API_KEY`.
- **Compatibilidad:** `AI_API_KEY` solo autentica un proveedor que esté configurado explícitamente y sea el único sin clave específica; nunca habilita varios proveedores a la vez.
- **Rutas y red:** `PORT`, `HOST`, `VOCAB_DB`, `VOCAB_DATA_FOLDER`, `VOCAB_TRUST_PROXY` y `VOCAB_CONFIG`.
- **Datos:** `VOCAB_INCLUDE_SUBFOLDERS`, `VOCAB_SEED_FROM_FOLDER_WHEN_EMPTY`, `VOCAB_PAGE_SIZE`, `VOCAB_MAX_PAGE_SIZE`, `VOCAB_MAX_IMPORT_BYTES` y `VOCAB_MAX_BACKUP_BYTES`.
- **IA:** `AI_TIMEOUT_MS`, `AI_CATALOG_TTL_MS`, `AI_CATALOG_TIMEOUT_MS` y `AI_MAX_TERMS`.

Los booleanos aceptan `true`, `false`, `1` o `0`. Un entero válido del entorno
sobrescribe el valor validado de `config.json`; si es inválido o está fuera de
rango, se usa el valor JSON válido o, en su defecto, el valor predeterminado
tipado. No se serializan estructuras como `ai.providers` en variables: usa otro
archivo mediante `VOCAB_CONFIG`.

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

En **Administración → Estadísticas** se puede elegir 7, 30 o 90 días, o todo el
historial. El panel resume vistas e interacciones con tarjetas, búsquedas y
búsquedas sin resultados, aprendizaje, generaciones diarias, resultados y
duración por proveedor/modelo, términos generados y conversión a tarjetas
guardadas. Gráficos con título y leyenda muestran las generaciones por día, la
actividad de estudio por día, el resultado de las generaciones, el reparto por
proveedor/modelo, las tarjetas más vistas y las búsquedas frecuentes. Las tablas
se apilan una debajo de otra, se paginan de forma independiente y comparten un
selector de registros por página (10, 15 o 20) que se conserva en el navegador.
Una vista de tarjeta solo cuenta si la tarjeta permanece visible (≥50% del
viewport) de forma continua durante al menos 5 segundos: el simple scroll no la
registra. Son métricas orientativas: cada navegador usa un UUID anónimo
persistente y un UUID por sesión. No se guardan IP, user-agent, tokens, prompts,
hints ni respuestas de IA; únicamente términos normalizados de búsqueda o
generación y los campos mínimos del evento.

La pestaña **Zona de peligro** agrupa las limpiezas. Antes de actuar muestra los
conteos vigentes, explica qué se conserva y exige una frase exacta. Se puede
limpiar por separado tarjetas, auditoría (`imports` y acciones administrativas),
métricas o reiniciar todo. Limpiar tarjetas incrementa una versión de datos que
descarta referencias locales obsoletas e inhibe permanentemente el seed
automático para esa base. Repetir una limpieza ya efectiva no cambia esa versión
ni crea otra marca si no queda nada del alcance por limpiar o restablecer.
Limpiar auditoría o reiniciar todo deja una única marca de la operación. El
reinicio total también restablece la curación y el
modelo IA predeterminado, pero nunca borra el archivo SQLite, `config.json`,
`.env` ni `data/seed`, ni ejecuta `VACUUM`. La limpieza de métricas no puede
borrar `localStorage` en navegadores desconectados.

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

## Despliegue con Docker Compose en Proxmox/LXC

Ejecuta una sola réplica. SQLite usa WAL y necesita que se conserve **todo
`/data`**; dos contenedores sobre el mismo archivo no constituyen un despliegue
horizontal soportado.

1. Instala Docker y el complemento Compose dentro de un LXC con las funciones
   necesarias para contenedores anidados.
2. Comprueba que el volumen y el directorio secreto sean legibles/escribibles
   por el UID/GID `1000:1000` usado por la imagen. En un LXC no privilegiado,
   considera el mapeo de UID del host; valida con `docker compose run --rm app id`.
3. Crea un `.env` de despliegue con `ADMIN_TOKEN`, `AI_SECRETS_DIR` absoluto y,
   si procede, `VOCAB_BIND_ADDRESS`, `VOCAB_PORT` y `VOCAB_TRUST_PROXY`.
4. Prepara `credentials.json` y arranca el servicio.

```bash
sudo install -d -m 0750 -o 1000 -g 1000 /srv/vocab-cards/secrets
sudo install -m 0400 -o 1000 -g 1000 /dev/null /srv/vocab-cards/secrets/credentials.json
sudoedit /srv/vocab-cards/secrets/credentials.json
docker compose up -d --build
docker compose ps
```

El archivo tiene un objeto JSON y solo admite `OPENCODE_API_KEY`,
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`AZURE_OPENAI_API_KEY` y `AI_API_KEY`. Por ejemplo:

```json
{
  "OPENAI_API_KEY": "valor-secreto"
}
```

Cuando `AI_CREDENTIALS_FILE` está configurado, ese archivo es autoritativo:
una ausencia, JSON inválido, campo desconocido, valor no textual o archivo
excesivo bloquea las operaciones IA con `503`; `{}` revoca todas las claves.
El servidor lo relee por operación y no expone claves, contenido, revisión ni
ruta. Rota de forma atómica reemplazando el archivo dentro del mismo directorio
montado, no sobrescribiéndolo parcialmente:

```bash
sudo install -m 0400 -o 1000 -g 1000 credentials.json.new /srv/vocab-cards/secrets/credentials.json.new
sudo mv /srv/vocab-cards/secrets/credentials.json.new /srv/vocab-cards/secrets/credentials.json
```

Cambiar `.env` o las variables de Docker **no modifica el entorno del proceso
vivo**: requiere `docker compose up -d --force-recreate`. En cambio,
`AI_CREDENTIALS_FILE` permite rotar o revocar las claves IA sin recrear el
contenedor. `AZURE_OPENAI_ENDPOINT` no es una credencial allowlisted; cambiarlo
también requiere recrear.

Compose publica por defecto `127.0.0.1:3000`, adecuado para un reverse proxy en
el mismo LXC. Termina TLS en Nginx, Caddy o HAProxy, reenvía a ese puerto y deja
`VOCAB_TRUST_PROXY=1`; si el proxy está en otra máquina, cambia explícitamente
`VOCAB_BIND_ADDRESS` y limita el acceso con firewall. Nunca publiques sin un
`ADMIN_TOKEN` robusto.

La imagen usa Node 24.21.0 sobre Debian Trixie slim y fija también el digest
multi-arquitectura para que una reconstrucción sea reproducible. El tag no se
actualiza por sí solo: revisa periódicamente los parches de Node y Debian,
verifica el digest manifest publicado para todas las arquitecturas necesarias,
actualiza tag y digest juntos en ambos stages, reconstruye y prueba antes de
desplegar.

El endpoint `GET /api/health` solo comprueba proceso y SQLite; no consulta
catálogos, modelos ni proveedores externos. Docker lo usa para determinar el
estado del contenedor.

## Despliegue con Node

```bash
npm ci
npm run build
npm prune --omit=dev
pm2 start "npm start" --name vocab
```

Pon Nginx o IIS (ARR) delante para HTTPS y ajusta `trustProxy`. Define
`ADMIN_TOKEN` antes de publicar: la clave viaja en cada petición de escritura.
El frontend usa rutas relativas, así que también funciona en un subdirectorio.

**Respaldos:** en **Administración → Carga de datos**, **Exportar tarjetas JSON**
solo descarga las tarjetas y sirve para importarlas o mezclarlas con otras. Para
un punto de restauración completo usa **Descargar archivo SQLite**: incluye
tarjetas, importaciones, auditoría, métricas, estados de aprendizaje y ajustes
de IA. La descarga se crea con la copia consistente de SQLite mientras el
servidor sigue atendiendo solicitudes.

Para restaurar, sube exclusivamente uno de esos archivos SQLite, escribe
`RESTAURAR BASE DE DATOS` y confirma. El servidor comprueba integridad,
versión y tablas requeridas antes de cerrar la conexión actual. Solo después
activa el archivo validado, reabre la base y reconstruye la caché; si falla el
relevo conserva y reactiva la base anterior. La restauración reemplaza todo el
estado actual y recarga el navegador. No restaura `.env`, `config.json`,
`data/seed` ni archivos fuera de `dbPath`.
