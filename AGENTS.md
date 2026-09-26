# AGENTS.md

Guía para agentes de código que trabajan en este repositorio.

## Qué es

Sitio para estudiar vocabulario en inglés con tarjetas que se voltean. Cada
tarjeta tiene significado, pronunciación (IPA americana y aproximación para
hispanohablantes), audio, contextos, formas y ejemplos. Las tarjetas se
guardan en SQLite y se crean pegando JSON, subiendo archivos o generándolas
con IA desde la búsqueda.

La interfaz y los mensajes están en **español**; el contenido que se estudia, en inglés.

## Comandos

```bash
npm install        # dependencias
npm run dev        # servidor + Vite con recarga en caliente → http://localhost:3000
npm test           # pruebas del backend (node:test)
npm run build      # compila el frontend en dist/
npm start          # producción: sirve dist/ (requiere build)
```

Requisito: Node.js 22.13 o superior (se usa `node:sqlite`); `.nvmrc` indica 24.
Los secretos van en `.env` (plantilla: `.env.example`); nunca en `config.json`.

## Estructura

```
server/            Backend Express 5 (ESM)
  index.js         Rutas, arranque, modo --dev con Vite como middleware
  config.js        config.json + variables de entorno
  db.js            SQLite: esquema, migraciones (PRAGMA user_version), consultas
  entry.js         normalizeEntry(): validación y forma canónica de una tarjeta; slug()
  vocab-store.js   Copia en memoria, query(), plan()/apply() de importación, export
  auth.js          Clave de administración (Bearer) para escrituras
  ai.js            Conector de IA: formato OpenAI y Anthropic, presets por proveedor
  prompt.js        Carga prompts/vocab-entry.prompt.md
  lenient-json.js  JSON con comentarios/comas finales; extrae bloques ```json
  test/            Pruebas (node:test)
web/               Frontend (Vite, varias páginas, JavaScript sin framework)
  index.html       Tarjetas
  import.html      Agregar tarjetas
  src/shared/      Utilidades comunes
  src/pages/cards/ app.js (tarjetas, filtros, scroll infinito, voz), ai-add.js (crear con IA)
  src/pages/import/import.js
  src/styles/      CSS con variables (tema claro/oscuro)
prompts/           Prompt de la IA (ver prompts/README.md)
schema/            JSON Schema del formato de datos
docs/              data-model.md: contrato de datos, base de datos y API
data/seed/         Datos de ejemplo; se importan si la base está vacía
```

## Contratos que deben mantenerse sincronizados

La forma de una tarjeta está definida en cuatro lugares. Un cambio en uno exige revisar los demás:

- `server/entry.js`: `normalizeEntry` es la fuente de verdad de lo que se guarda.
- `schema/vocab-entries.schema.json`.
- `prompts/vocab-entry.prompt.md`.
- `docs/data-model.md`.

La regla del `id` (`slug()`) decide si una importación crea o actualiza una
tarjeta; no la cambies sin una migración de ids.

## Convenciones

- **Módulos:** ESM en todo el proyecto. El frontend usa módulos importados por Vite, no variables globales.
- **Dependencias:** no agregues dependencias de ejecución sin justificarlo; el backend usa solo `express` y `express-rate-limit`. Nada que requiera compilación nativa, porque debe instalarse en Windows sin herramientas de C++.
- **Seguridad del HTML:** todo texto que venga de datos se inserta con `esc()`.
- **Idioma y estilo:** textos de la interfaz, comentarios y mensajes de error en español; los mensajes de error deben decir qué pasó y qué hacer.
- **Escrituras:** toda ruta que escribe en la base de datos va detrás de `auth.require` y del limitador de escrituras.
- **Accesibilidad:** foco visible, `aria-*` en controles personalizados, textos alternativos, `prefers-reduced-motion`.
- **CSS:** usa las variables de `web/src/styles/base.css` (colores por `--k-<kind>`); no uses colores fijos nuevos sin su versión oscura.

## Cómo verificar un cambio

1. Ejecuta `npm test`: debe pasar completo. Agrega pruebas en `server/test/` para la lógica nueva del backend.
2. Ejecuta `npm run build`: debe compilar sin errores.
3. Si tocaste el frontend, pruébalo con `npm run dev` en el navegador. Revisa la página de tarjetas y la de agregar, en tema claro y oscuro y en ancho de móvil.

## Qué no hacer

- **Secretos:** no subas `.env`, bases de datos (`data/*.db`) ni claves.
- **Configuración:** no escribas claves de API en `config.json`.
- **Datos:** no cambies el formato de `data/seed/` sin actualizar el esquema.
