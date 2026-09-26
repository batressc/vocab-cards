/* Utilidades compartidas por todas las páginas. */

export const $ = s => document.querySelector(s);

/** Escapa texto para insertarlo en HTML. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

/** localStorage con JSON y tolerante a errores (modo privado, cuota llena). */
export const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } }
};

export const fmtDate = iso => { try { return new Intl.DateTimeFormat('es', { dateStyle:'medium' }).format(new Date(iso)); } catch { return ''; } };
export const fmtDateTime = iso => { try { return new Intl.DateTimeFormat('es', { dateStyle:'medium', timeStyle:'short' }).format(new Date(iso)); } catch { return ''; } };
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Clave de administración guardada en este navegador. */
export const ADMIN_TOKEN_KEY = 'vocab-admin-token';
export const OPENCODE_SESSION_LIMIT_KEY = 'vocab-opencode-session-limit';
export const AI_DEFAULT_MODEL_KEY = 'vocab-ai-default-model';

/** Busca un par proveedor/modelo dentro del catálogo público vigente. */
export function findAiModel(info, value){
  if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string') return null;
  for (const provider of Array.isArray(info?.providers) ? info.providers : []) {
    if (provider?.id !== value.provider || !Array.isArray(provider.models)) continue;
    const model = provider.models.find(item => item?.id === value.model);
    if (model) return { provider, model };
  }
  return null;
}

/** Resuelve el predeterminado guardado, descartando valores corruptos u obsoletos. */
export function resolveAiDefaultModel(info){
  const saved = findAiModel(info, store.get(AI_DEFAULT_MODEL_KEY, null));
  const fallback = saved || findAiModel(info, info?.default);
  if (fallback) return { provider: fallback.provider.id, model: fallback.model.id };
  const provider = (Array.isArray(info?.providers) ? info.providers : []).find(item => Array.isArray(item?.models) && item.models.length);
  return provider ? { provider: provider.id, model: provider.models[0].id } : null;
}

let toastTimer;
/** Mensaje breve en la parte inferior de la pantalla (requiere un #toast en la página). */
export function toast(msg, ms = 3400){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
