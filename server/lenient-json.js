/** Permite comentarios (// y /* *\/) y comas finales en los archivos JSON. */
export function parseLenientJson(text){
  // Recorre el texto respetando las cadenas; `onChar` decide qué hacer fuera de ellas.
  const scan = (src, onChar) => {
    let out = '', i = 0, inStr = false;
    while (i < src.length) {
      const c = src[i];
      if (inStr) {
        out += c;
        if (c === '\\') { out += src[i + 1] ?? ''; i += 2; continue; }
        if (c === '"') inStr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      const r = onChar(src, i);
      out += r.text; i = r.next;
    }
    return out;
  };
  // 1) Quita comentarios (conserva los saltos de línea para reportar bien la línea).
  const noComments = scan(text, (s, i) => {
    if (s[i] === '/' && s[i + 1] === '/') { let j = i; while (j < s.length && s[j] !== '\n') j++; return { text:'', next:j }; }
    if (s[i] === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2), stop = end < 0 ? s.length : end + 2;
      return { text:s.slice(i, stop).replace(/[^\n]/g, ' '), next:stop };
    }
    return { text:s[i], next:i + 1 };
  });
  // 2) Quita comas finales antes de ] o }.
  const clean = scan(noComments, (s, i) => {
    if (s[i] === ',') { let j = i + 1; while (j < s.length && /\s/.test(s[j])) j++; if (s[j] === ']' || s[j] === '}') return { text:' ', next:i + 1 }; }
    return { text:s[i], next:i + 1 };
  });
  return JSON.parse(clean.replace(/^\uFEFF/, ''));
}

/** Traduce la posición de un error de JSON.parse a número de línea. */
export function jsonErrorLine(err, text){
  const m = /position (\d+)/i.exec(err.message) || /line (\d+)/i.exec(err.message);
  if (!m) return '';
  if (/line/i.test(m[0])) return ` en la línea ${m[1]}`;
  return ` en la línea ${text.slice(0, Number(m[1])).split('\n').length}`;
}

/**
 * Extrae el JSON de un texto pegado: acepta la respuesta de una IA tal cual,
 * con bloques ```json ... ``` y texto alrededor. Devuelve una lista de fragmentos.
 */
export function extractJsonBlocks(text){
  const clean = String(text ?? '').replace(/^\uFEFF/, '');
  const fences = [...clean.matchAll(/```[a-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/gi)].map(m => m[1]).filter(s => s.trim());
  if (fences.length) return fences;
  // Sin bloques: toma desde el primer [ o { hasta el último ] o }.
  const start = clean.search(/[[{]/);
  const end = Math.max(clean.lastIndexOf(']'), clean.lastIndexOf('}'));
  return start >= 0 && end > start ? [clean.slice(start, end + 1)] : [clean];
}
