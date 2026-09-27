/* Telemetría anónima y orientativa: registra acciones semánticas, nunca contenido completo. */
import { store } from './utils.js';

const CLIENT_KEY = 'vocab-telemetry-client';
const SESSION_KEY = 'vocab-telemetry-session';
const uuid = () => typeof crypto.randomUUID === 'function'
  ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, value => {
    const random = crypto.getRandomValues(new Uint8Array(1))[0] & 15;
    return (value === 'x' ? random : (random & 3) | 8).toString(16);
  });
const clientId = store.get(CLIENT_KEY, '') || uuid();
store.set(CLIENT_KEY, clientId);
let sessionId;
try {
  sessionId = sessionStorage.getItem(SESSION_KEY) || uuid();
  sessionStorage.setItem(SESSION_KEY, sessionId);
} catch { sessionId = uuid(); }

let queue = [];
let timer;

function send(events, beacon = false){
  if (!events.length) return;
  const body = JSON.stringify({ clientId, sessionId, events });
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon('api/telemetry/events', new Blob([body], { type:'application/json' }));
    return;
  }
  fetch('api/telemetry/events', {
    method:'POST', headers:{ 'Content-Type':'application/json' }, body, keepalive:true
  }).catch(() => {});
}

function flush(){
  clearTimeout(timer); timer = null;
  const events = queue.splice(0, 50);
  send(events);
  if (queue.length) timer = setTimeout(flush, 1000);
}

export function track(type, data = {}){
  queue.push({ type, ...data });
  if (queue.length >= 20) flush();
  else timer ??= setTimeout(flush, 1000);
}

const observed = new WeakSet();
const viewed = new Set();
const cardObserver = new IntersectionObserver(entries => {
  for (const item of entries) {
    if (!item.isIntersecting || item.intersectionRatio < 0.5) continue;
    const id = item.target.dataset.id;
    if (!viewed.has(id)) { viewed.add(id); track('card_view', { entryId:id }); }
    cardObserver.unobserve(item.target);
  }
}, { threshold:0.5 });

export function observeCards(root){
  for (const card of root.querySelectorAll('.card[data-id]')) {
    if (!observed.has(card)) { observed.add(card); cardObserver.observe(card); }
  }
}

addEventListener('pagehide', () => {
  clearTimeout(timer);
  send(queue.splice(0, 50), true);
});
