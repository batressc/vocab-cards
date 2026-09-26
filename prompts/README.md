# Prompts

| Archivo | Uso |
|---|---|
| `vocab-entry.prompt.md` | Prompt de sistema con el que la IA genera tarjetas. |

## Cómo lo usa la aplicación

`server/prompt.js` lee `vocab-entry.prompt.md` en cada generación y lo envía
como **mensaje de sistema**. El mensaje de usuario es la lista de términos:

```
LISTA:
take off (despegar un avión)
run into
```

Cada línea es un término; lo que va entre paréntesis es la aclaración de
sentido que el usuario escribe en el diálogo "Crear con IA". Los cambios al
archivo se aplican sin reiniciar el servidor. La ruta se puede cambiar con
`ai.promptFile` en `config.json`.

## Uso manual (ChatGPT, Gemini, Claude…)

Copia el contenido completo de `vocab-entry.prompt.md` en el chat, agrega al
final `LISTA:` y tus palabras (una por línea), y pega la respuesta en
**Agregar tarjetas → Pegar JSON**. El importador acepta la respuesta tal cual,
aunque venga dentro de un bloque ` ```json ` o con texto alrededor.

## Reglas para modificar el prompt

El prompt, el esquema y el código de validación describen el mismo contrato.
Si cambias uno, revisa los otros:

1. `prompts/vocab-entry.prompt.md`: lo que se le pide a la IA.
2. `schema/vocab-entries.schema.json`: el formato de archivo que se valida en el editor.
3. `server/entry.js` (`normalizeEntry`): lo que el servidor acepta y guarda.
4. `docs/data-model.md`: la documentación del contrato.

Mantén especialmente estas partes, porque el código depende de ellas:

- **La respuesta:** un objeto `{ "entries": [...] }`.
- **La regla del `id`:** debe coincidir con `slug()` de `server/entry.js`; con ella se detectan duplicados y actualizaciones.
- **Los valores permitidos:** los de `kind` y `level`.
- **La notación de `lat`:** la sílaba tónica en MAYÚSCULAS, porque el frontend la resalta.
- **`addedAt`:** no pedirlo a la IA, porque la fecha la asigna el servidor.

Después de editar, ejecuta `npm test`: una prueba verifica que el prompt se
carga y se envía como mensaje de sistema.
