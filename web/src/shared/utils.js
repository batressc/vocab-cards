/* Utilidades compartidas por todas las páginas. */

export const $ = s => document.querySelector(s);

/** Escapa texto para insertarlo en HTML. */
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

/** localStorage con JSON y tolerante a errores (modo privado, cuota llena). */
export const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } }
};

export const fmtDate = iso => { try { return new Intl.DateTimeFormat('es', { dateStyle:'medium' }).format(new Date(iso)); } catch { return ''; } };
export const fmtDateTime = iso => { try { return new Intl.DateTimeFormat('es', { dateStyle:'medium', timeStyle:'short' }).format(new Date(iso)); } catch { return ''; } };
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Clave de administración guardada en este navegador. */
export const ADMIN_TOKEN_KEY = 'vocab-admin-token';
export const OPENCODE_SESSION_LIMIT_KEY = 'vocab-opencode-session-limit';

let toastTimer;
/** Mensaje breve en la parte inferior de la pantalla (requiere un #toast en la página). */
export function toast(msg, ms = 3400){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
